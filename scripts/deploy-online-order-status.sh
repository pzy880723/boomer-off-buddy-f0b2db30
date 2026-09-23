#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/xintiandi-listing-scope-20260923"
release="$base/releases/online-order-status-20260924"
candidate=boomer-online-orders-candidate
patch=/tmp/boomer-online-order-patch

check() {
  local port="$1" ready=0
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/public/handheld/openapi.json" -o /tmp/boomer-online-orders-openapi.json; then ready=1; break; fi
    sleep 2
  done
  [[ "$ready" == 1 ]]
  node scripts/check-login-hydration.mjs "http://127.0.0.1:$port"
  node --env-file="$release/.env" scripts/verify-listing-auth-live.mjs "http://127.0.0.1:$port"
  for route in orders payments; do
    code=$(curl -sS --max-time 10 -o /tmp/boomer-online-orders-anon.json -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/public/storefront/$route")
    [[ "$code" == 401 ]]
    node -e 'JSON.parse(require("fs").readFileSync("/tmp/boomer-online-orders-anon.json","utf8"))'
  done
}

case "${1:-}" in
  prepare)
    [[ "$(readlink -f "$base/current")" == "$old" ]]
    [[ ! -e "$release" ]]
    [[ -z "$(ss -Hlt 'sport = :3006')" ]]
    cd "$old"
    sha256sum -c "$patch/baseline.sha256"
    mkdir -p "$release"
    tar -C "$old" --exclude=node_modules --exclude=.output --exclude=.env --exclude='.env.*' --exclude=.git --exclude='._*' -cf - . | tar -C "$release" -xf -
    ln -s "$old/node_modules" "$release/node_modules"
    ln -s "$old/.env" "$release/.env"
    cp -R "$patch/src/." "$release/src/"
    cd "$release"
    npm run build:tencent > /tmp/boomer-online-orders-build.log 2>&1
    APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
    check 3006
    echo "Candidate ready: $release"
    ;;
  activate)
    [[ "$(readlink -f "$base/current")" == "$old" ]]
    cd "$release"
    check 3006
    rollback_needed=1
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
    pm2 delete boomer-off-buddy >/dev/null
    APP_DIR="$release" ERP_PORT=3005 pm2 start "$release/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$release" --interpreter bash --time >/dev/null
    check 3005
    node scripts/check-login-hydration.mjs https://erp.boomeroff.com
    node --env-file="$release/.env" scripts/verify-listing-auth-live.mjs https://erp.boomeroff.com
    ln -sfn "$release" "$base/current"
    pm2 save >/dev/null
    rollback_needed=0
    echo "release=$release previous=$old"
    ;;
  *) echo 'Usage: deploy-online-order-status.sh prepare|activate' >&2; exit 2 ;;
esac
