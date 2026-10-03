#!/usr/bin/env bash
# Scoped POS release. Does not apply SQL or enable points redemption.
set -euo pipefail
base=/var/www/boomer-erp
old=${POS_PREVIOUS_RELEASE:-$base/releases/product-sale-repair-20260927}
release=${POS_NEXT_RELEASE:-$base/releases/pos-unified-b52dfb8-20261003}
archive=${POS_SOURCE_ARCHIVE:-/tmp/boomer-pos-b52dfb8.tar.gz}
candidate=boomer-pos-candidate
workers=/etc/boomer-erp/workers.env
case "${1:-}" in prepare|verify|publish|rollback) mode=$1 ;; *) exit 2 ;; esac
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
    -u YOUZAN_ORDER_SYNC_WORKER_ENABLED -u ERP_WORKER_ENV_FILE \
    HANDHELD_LISTING_IMAGE_WORKER_ENABLED=true APP_DIR="$1" ERP_PORT=3005 \
    pm2 start "$1/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$1" --interpreter bash --time >/dev/null
}
verify() {
  node scripts/check-login-hydration.mjs "$1"
  node --env-file=.env scripts/verify-youzan-worker-guards.mjs "$1" "${2:-}"
  node --input-type=module - "$1" <<'VERIFY'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base=process.argv[2];
const asset=(await readFile('.pos-asset','utf8')).trim();
assert.match(asset,/^[a-zA-Z0-9_-]+\.js$/);
const response=await fetch(`${base}/assets/${asset}`,{cache:'no-store'});
assert.equal(response.status,200);
const text=await response.text();
assert.equal(text,await readFile(`.output/public/assets/${asset}`,'utf8'));
for(const label of ['自定义商品','购物车','积分']) assert.ok(text.includes(label),label);
assert.ok(!text.includes('本单结算'));
for(const route of ['standard-catalog','products','bootstrap']) {
  const r=await fetch(`${base}/api/public/pos/${route}?location_id=00000000-0000-4000-8000-000000000000`);
  assert.equal(r.status,401,route);
}
console.log(JSON.stringify({base,asset,exactAssetMatch:true,sqlApplied:false,transactionsCreated:0}));
VERIFY
}
if [[ "$mode" == rollback ]]; then
  [[ "$(readlink -f "$base/current")" == "$release" ]] || exit 1
  pm2 delete boomer-off-buddy >/dev/null
  start_live "$old"
  ready 3005
  ln -sfn "$old" "$base/current"
  pm2 save >/dev/null
  exit
fi
[[ "$(readlink -f "$base/current")" == "$old" ]] || exit 1
if [[ "$mode" == prepare ]]; then
  [[ ! -e "$release" ]] || exit 1
  sha256sum -c "$archive.sha256"
  # Only regular source files from the reviewed commit enter this archive.
  tar -tzf "$archive" | awk '/(^\/|(^|\/)\.\.($|\/)|(^|\/)\.env($|\/)|^node_modules\/|^\.output\/)/ {bad=1} END {exit bad}'
  tar -tvzf "$archive" | awk 'substr($1,1,1)!="-" && substr($1,1,1)!="d" {bad=1} END {exit bad}'
  cp -a "$old" "$release"
  tar -xzf "$archive" -C "$release"
  cd "$release"
  sha256sum "$workers" > .pos-workers.sha256
  NODE_OPTIONS=--max-old-space-size=3072 timeout 1200s npm run build:tencent > /tmp/boomer-pos-candidate-build.log 2>&1
  grep -l '本单最多' .output/public/assets/*.js | xargs -n1 basename > .pos-asset
  [[ "$(wc -l < .pos-asset)" -eq 1 ]]
  # Preserve old hashed assets for already-open browser sessions during rollout.
  cp -an "$old/.output/public/assets/." .output/public/assets/
  env APP_DIR="$release" ERP_PORT=3006 HANDHELD_RELEASE_WORKER_ENABLED=false \
    HANDHELD_ITEM_SYNC_WORKER_ENABLED=false HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false \
    YOUZAN_STOCK_WORKER_ENABLED=false YOUZAN_IMAGE_REFRESH_WORKER_ENABLED=false \
    YOUZAN_ORDER_SYNC_WORKER_ENABLED=false pm2 start "$release/scripts/run-tencent-erp.sh" \
    --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
  ready 3006
  verify http://127.0.0.1:3006 --candidate
  find src .output -type f -print0 | sort -z | xargs -0 sha256sum > .pos-ready.sha256
  echo 'Candidate verified; not published.'
  exit
fi
cd "$release"
if [[ "$mode" == verify ]]; then
  sha256sum -c .pos-workers.sha256
  # Keep the freshly built asset recorded before old session assets were copied.
  [[ "$(wc -l < .pos-asset)" -eq 1 ]]
  ready 3006
  verify http://127.0.0.1:3006 --candidate
  find src .output -type f -print0 | sort -z | xargs -0 sha256sum > .pos-ready.sha256
  exit
fi
sha256sum -c .pos-workers.sha256
sha256sum --status -c .pos-ready.sha256
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
    echo 'Release failed; previous production restored.' >&2
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
echo "POS published: $release; previous release retained; SQL unchanged."
