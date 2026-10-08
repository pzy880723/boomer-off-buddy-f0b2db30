#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old=$base/releases/fankuang-20261008-v2
release=$base/releases/listing-retouch-20261009
candidate=boomer-listing-retouch-candidate
archive=/tmp/boomer-listing-retouch-20261009.tar.gz
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
    -u HANDHELD_LISTING_IMAGE_WORKER_ENABLED -u YOUZAN_STOCK_WORKER_ENABLED \
    -u YOUZAN_IMAGE_REFRESH_WORKER_ENABLED -u YOUZAN_ORDER_SYNC_WORKER_ENABLED \
    -u YOUZAN_SALE_COMPENSATION_ENABLED -u CHANNEL_SYNC_WORKER_ENABLED -u ERP_WORKER_ENV_FILE \
    APP_DIR="$1" ERP_PORT=3005 pm2 start "$1/scripts/run-tencent-erp.sh" \
    --name boomer-off-buddy --cwd "$1" --interpreter bash --time >/dev/null
}
verify() {
  timeout 90s node scripts/check-login-hydration.mjs "$1"
  timeout 90s node --env-file=.env scripts/verify-youzan-worker-guards.mjs "$1" "${2:-}"
  timeout 90s node scripts/verify-fankuang-release.mjs "$1"
}
verify_manifest() {
  curl -fsS --max-time 10 "$1/retouch-release.json" | node --input-type=module -e 'let text="";for await(const chunk of process.stdin)text+=chunk;if(JSON.parse(text).release!=="listing-retouch-20261009")process.exit(1);'
}
if [[ "$mode" == rollback ]]; then
  [[ "$(readlink -f "$base/current")" == "$release" ]] || exit 1
  pm2 delete boomer-off-buddy >/dev/null
  start_live "$old"
  ready 3005
  ln -sfn "$old" "$base/current"
  pm2 save >/dev/null
  echo "rollback=$old"
  exit
fi
[[ "$(readlink -f "$base/current")" == "$old" ]] || exit 1
if [[ "$mode" == build ]]; then
  [[ ! -e "$release" && -z "$(ss -Hlt 'sport = :3006')" ]] || exit 1
  [[ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -gt 4000000 ]] || { echo 'Insufficient build memory' >&2; exit 1; }
  tar -tzf "$archive" | while IFS= read -r entry; do
    case "$entry" in
      src/server/handheld-ai.server.ts|src/server/listing-image-safety.server.ts|src/server/handheld-ai-image-timeout.test.ts|src/server/listing-image-safety.test.ts|src/server/listing-image-validation.test.ts|scripts/probe-listing-retouch-20261009.mjs|scripts/deploy-listing-retouch-20261009.sh) ;;
      *) echo "Unexpected archive entry: $entry" >&2; exit 1 ;;
    esac
  done
  cp -a "$old" "$release"
  cd "$release"
  sha256sum /etc/boomer-erp/workers.env .env > .retouch-environment.sha256
  tar -xzf "$archive" -C "$release"
  node --experimental-strip-types --test --test-reporter=tap src/server/listing-image-validation.test.ts src/server/listing-image-safety.test.ts src/server/handheld-ai-image-timeout.test.ts src/server/product-content-image-jobs.test.ts > /tmp/boomer-listing-retouch-tests.log 2>&1
  NODE_OPTIONS=--max-old-space-size=2560 timeout 1200s npm run build:tencent > /tmp/boomer-listing-retouch-build.log 2>&1
  cp -an "$old/.output/public/assets/." .output/public/assets/
  node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync(".output/public/retouch-release.json",JSON.stringify({release:"listing-retouch-20261009",features:["remove-real-hands","preserve-ruler","preserve-detail-angle","cloud-output-review"]}));'
  env APP_DIR="$release" ERP_PORT=3006 HANDHELD_RELEASE_WORKER_ENABLED=false \
    HANDHELD_ITEM_SYNC_WORKER_ENABLED=false HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false \
    YOUZAN_STOCK_WORKER_ENABLED=false YOUZAN_IMAGE_REFRESH_WORKER_ENABLED=false \
    YOUZAN_ORDER_SYNC_WORKER_ENABLED=false YOUZAN_SALE_COMPENSATION_ENABLED=false \
    CHANNEL_SYNC_WORKER_ENABLED=false pm2 start "$release/scripts/run-tencent-erp.sh" \
    --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
  ready 3006
  verify http://127.0.0.1:3006 --candidate
  verify_manifest http://127.0.0.1:3006
  sha256sum --check --status .retouch-environment.sha256
  find src scripts infra .output -type f -print0 | sort -z | xargs -0 sha256sum > .retouch-ready.sha256
  echo 'Candidate ready; production unchanged, no candidate jobs consumed.'
  exit
fi
cd "$release"
sha256sum --check --status .retouch-environment.sha256
sha256sum --check --status .retouch-ready.sha256
verify http://127.0.0.1:3006 --candidate
verify_manifest http://127.0.0.1:3006
rollback=1
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [[ "$rollback" == 1 ]]; then
    pm2 delete boomer-off-buddy >/dev/null 2>&1
    if start_live "$old" && ready 3005 && ln -sfn "$old" "$base/current" && pm2 save >/dev/null; then
      echo "Release failed; restored $old" >&2
    else echo "ROLLBACK FAILED; inspect retained release $old" >&2; fi
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
pm2 delete boomer-off-buddy >/dev/null
start_live "$release"
ready 3005
verify https://erp.boomeroff.com
verify_manifest https://erp.boomeroff.com
sha256sum --check --status .retouch-environment.sha256
ln -sfn "$release" "$base/current"
pm2 delete "$candidate" >/dev/null
pm2 save >/dev/null
rollback=0
echo "published=$release rollback=$old environment=unchanged"
