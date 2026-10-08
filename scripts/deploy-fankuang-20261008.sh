#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old=$base/releases/fankuang-20261008
release=$base/releases/fankuang-20261008-v2
candidate=boomer-fankuang-candidate
case "${1:-}" in build|publish|rollback) mode=$1 ;; *) exit 2 ;; esac
exec 9>/var/lock/boomer-erp-release.lock
flock -n 9
ready() {
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$1/api/public/handheld/openapi.json" -o /dev/null; then return; fi
    sleep 2
  done
  return 1
}
start_live() {
  env -u HANDHELD_RELEASE_WORKER_ENABLED -u HANDHELD_ITEM_SYNC_WORKER_ENABLED \
    -u YOUZAN_STOCK_WORKER_ENABLED -u YOUZAN_IMAGE_REFRESH_WORKER_ENABLED \
    -u YOUZAN_ORDER_SYNC_WORKER_ENABLED -u YOUZAN_SALE_COMPENSATION_ENABLED \
    -u CHANNEL_SYNC_WORKER_ENABLED -u ERP_WORKER_ENV_FILE \
    HANDHELD_LISTING_IMAGE_WORKER_ENABLED=true APP_DIR="$1" ERP_PORT=3005 \
    pm2 start "$1/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$1" --interpreter bash --time >/dev/null
}
verify() {
  node scripts/check-login-hydration.mjs "$1"
  node --env-file=.env scripts/verify-youzan-worker-guards.mjs "$1" "${2:-}"
  node scripts/verify-fankuang-release.mjs "$1"
}
if [[ "$mode" == rollback ]]; then
  [[ "$(readlink -f "$base/current")" == "$release" ]] || exit 1
  pm2 delete boomer-off-buddy >/dev/null
  start_live "$old"
  ready 3005
  ln -sfn "$old" "$base/current"
  pm2 save >/dev/null
  echo 'Previous source restored; nullable enrollment data retained.'
  exit
fi
[[ "$(readlink -f "$base/current")" == "$old" ]] || exit 1
if [[ "$mode" == build ]]; then
  [[ ! -e "$release" && -z "$(ss -Hlt 'sport = :3006')" ]] || exit 1
  cp -a "$old" "$release"
  tar -xzf /tmp/boomer-fankuang-overlay.tar.gz -C "$release"
  cd "$release"
  sha256sum /etc/boomer-erp/workers.env > .fankuang-workers.sha256
  NODE_OPTIONS=--max-old-space-size=3072 timeout 1200s npm run build:tencent > /tmp/boomer-fankuang-build.log 2>&1
  cp -an "$old/.output/public/assets/." .output/public/assets/
  env APP_DIR="$release" ERP_PORT=3006 HANDHELD_RELEASE_WORKER_ENABLED=false \
    HANDHELD_ITEM_SYNC_WORKER_ENABLED=false HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false \
    YOUZAN_STOCK_WORKER_ENABLED=false YOUZAN_IMAGE_REFRESH_WORKER_ENABLED=false \
    YOUZAN_ORDER_SYNC_WORKER_ENABLED=false YOUZAN_SALE_COMPENSATION_ENABLED=false \
    CHANNEL_SYNC_WORKER_ENABLED=false pm2 start "$release/scripts/run-tencent-erp.sh" \
    --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
  ready 3006
  verify http://127.0.0.1:3006 --candidate
  sha256sum --check --status .fankuang-workers.sha256
  find src scripts infra .output -type f -print0 | sort -z | xargs -0 sha256sum > .fankuang-ready.sha256
  echo 'Candidate ready; no production jobs consumed.'
  exit
fi
cd "$release"
sha256sum --check --status .fankuang-workers.sha256
sha256sum --check --status .fankuang-ready.sha256
verify http://127.0.0.1:3006 --candidate
rollback=1
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$rollback" == 1 ]]; then
    pm2 delete boomer-off-buddy >/dev/null 2>&1 || true
    start_live "$old"
    ready 3005
    ln -sfn "$old" "$base/current"
    pm2 save >/dev/null
    echo 'Release failed; preceding production restored.' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
pm2 delete boomer-off-buddy >/dev/null
start_live "$release"
ready 3005
verify https://erp.boomeroff.com
ln -sfn "$release" "$base/current"
pm2 delete "$candidate" >/dev/null
pm2 save >/dev/null
rollback=0
echo 'Fankuang release published; previous release and workers preserved.'
