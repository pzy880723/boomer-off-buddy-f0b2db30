#!/usr/bin/env bash
set -euo pipefail
# Run as root: the live ERP belongs to root PM2, not ubuntu PM2.
[[ "$EUID" == 0 ]] || { echo 'Use root PM2 deployment context' >&2; exit 2; }
sha="${1:?reviewed commit required}"
expected_previous="${2:?validated previous release required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
base=/var/www/boomer-erp
old="$(readlink -f "$base/current")"
[[ "$old" == "$expected_previous" ]] || { echo 'Production changed; review required' >&2; exit 3; }
release="$base/releases/$sha"
candidate=boomer-ordinary-payment-candidate
[[ -z "$(ss -Hlt 'sport = :3006')" && ! -e "$release" ]] || exit 4
mkdir -p "$release"
tar -xzf "/tmp/boomer-ordinary-source-$sha.tgz" -C "$release" --exclude=.env --exclude='._*'
tar -xzf "/tmp/boomer-ordinary-output-$sha.tgz" -C "$release" --exclude=.env --exclude='._*'
ln -s "$base/shared/.env" "$release/.env"
ln -s "$old/node_modules" "$release/node_modules"
node -e 'const fs=require("fs"),p=process.argv[1];if(JSON.parse(fs.readFileSync(p+"/.output/nitro.json","utf8")).preset!=="node-server"||!fs.existsSync(p+"/.output/server/index.mjs"))throw Error("Expected reviewed Node production artifact")' "$release"

check_health() {
  local port="$1" code ready=0
  for attempt in $(seq 1 25); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/public/handheld/openapi.json" -o "/tmp/ordinary-openapi-$port.json"; then ready=1; break; fi
    sleep 2
  done
  [[ "$ready" == 1 ]] || return 1
  node -e 'const s=require(process.argv[1]);if(!s.openapi||!s.paths["/api/public/handheld/products"])throw Error("Missing legacy handheld contract")' "/tmp/ordinary-openapi-$port.json"
  for endpoint in payments payments/reconcile payments/refund; do
    code="$(curl -sS --max-time 20 -X POST -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/public/storefront/$endpoint")"
    [[ "$code" == 401 ]] || { echo "Unauthenticated $endpoint returned $code" >&2; return 1; }
  done
  code="$(curl -sS --max-time 20 -X POST -d '{}' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/internal/payments/reconcile")"
  [[ "$code" == 401 ]] || return 1
  code="$(curl -sS --max-time 20 -X POST -H 'Content-Type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/public/storefront/payments/wechat-notify")"
  [[ "$code" == 503 ]] || return 1
  node "$release/scripts/check-login-hydration.mjs" "http://127.0.0.1:$port"
  node "$release/scripts/check-ordinary-payment-http.mjs" "http://127.0.0.1:$port"
}

rollback_needed=0
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$result" != 0 && "$rollback_needed" == 1 ]]; then
    pm2 delete boomer-off-buddy >/dev/null 2>&1 || true
    APP_DIR="$old" ERP_PORT=3005 pm2 start "$old/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$old" --interpreter bash --time >/dev/null
    ln -sfn "$old" "$base/current"
    pm2 save >/dev/null
    echo "Rolled back to $old" >&2
  fi
  pm2 delete "$candidate" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
check_health 3006
echo 'Candidate legacy routes, payment authorization and callback rejection verified'
[[ "$(readlink -f "$base/current")" == "$old" ]] || exit 6
rollback_needed=1
pm2 delete boomer-off-buddy >/dev/null
APP_DIR="$release" ERP_PORT=3005 pm2 start "$release/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$release" --interpreter bash --time >/dev/null
check_health 3005
ln -sfn "$release" "$base/current"
pm2 delete "$candidate" >/dev/null
pm2 save >/dev/null
rollback_needed=0
printf 'release=%s\nprevious=%s\nordinary_checkout=disabled_pending_acceptance\n' "$release" "$old"
