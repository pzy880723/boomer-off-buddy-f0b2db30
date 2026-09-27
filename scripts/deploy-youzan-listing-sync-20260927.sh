#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/era-estimate-20260927-r2"
release="$base/releases/youzan-listing-sync-20260927"
candidate=boomer-youzan-listing-candidate

ready() {
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$1/api/public/handheld/openapi.json" -o /dev/null; then return; fi
    sleep 2
  done
  return 1
}
verify() {
  node --env-file=.env scripts/verify-listing-content-live.mjs "$1"
  node --env-file=.env scripts/verify-custom-transfers-live.mjs "$1"
  node --env-file=.env scripts/verify-item-delete-live.mjs "$1"
}
[[ "$(readlink -f "$base/current")" == "$old" ]]
case "${1:-}" in
  prepare)
    [[ ! -e "$release" && -z "$(ss -Hlt 'sport = :3006')" ]]
    mkdir -p "$release"
    cp -a "$old/." "$release/"
    cd "$release"
    tar -xzf /tmp/boomer-youzan-listing-sync.tar.gz -C "$release"
    NODE_OPTIONS=--max-old-space-size=3072 npm run build:tencent > /tmp/boomer-youzan-listing-build.log 2>&1
    APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
    ready 3006
    verify http://127.0.0.1:3006
    node --env-file=.env scripts/verify-youzan-worker-guards.mjs http://127.0.0.1:3006 --candidate
    echo "candidate_ready=$release"
    ;;
  publish)
    cd "$release"
    verify http://127.0.0.1:3006
    [[ "$(sha256sum /etc/boomer-erp/workers.env | cut -d' ' -f1)" == 4815f4d9d86068a8ef175f2b6577ff4c08813e737cad57159c01bbce5310c991 ]]
    cp -a /etc/boomer-erp/workers.env /etc/boomer-erp/workers.before-youzan-20260927.env
    rollback=1
    cleanup() {
      status=$?
      trap - EXIT
      if [[ "$rollback" == 1 ]]; then
        cp -a /etc/boomer-erp/workers.before-youzan-20260927.env /etc/boomer-erp/workers.env
        pm2 delete boomer-off-buddy >/dev/null 2>&1 || true
        APP_DIR="$old" ERP_PORT=3005 pm2 start "$old/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$old" --interpreter bash --time >/dev/null
        ln -sfn "$old" "$base/current"
        pm2 save >/dev/null
      fi
      pm2 delete "$candidate" >/dev/null 2>&1 || true
      exit "$status"
    }
    trap cleanup EXIT
    install -m 600 /tmp/boomer-youzan-workers-20260927.env /etc/boomer-erp/workers.env
    pm2 delete boomer-off-buddy >/dev/null
    APP_DIR="$release" ERP_PORT=3005 pm2 start "$release/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$release" --interpreter bash --time >/dev/null
    ready 3005
    verify https://erp.boomeroff.com
    node --env-file=.env scripts/verify-youzan-worker-guards.mjs https://erp.boomeroff.com
    ln -sfn "$release" "$base/current"
    pm2 save >/dev/null
    rollback=0
    echo "published=$release rollback=$old"
    ;;
  *) echo 'Usage: prepare | publish' >&2; exit 2 ;;
esac
