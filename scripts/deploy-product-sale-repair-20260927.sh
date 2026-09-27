#!/usr/bin/env bash
# Main reviews/applies SQL separately. This script never applies migrations or repairs orders.
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/listing-image-recovery-20260927"
release="$base/releases/product-sale-repair-20260927"
archive=/tmp/boomer-product-sale-repair-20260927.tar.gz
candidate=boomer-product-sale-repair-candidate
workers=/etc/boomer-erp/workers.env
stamp="$release/.product-sale-repair-ready"
worker_hash="$release/.product-sale-repair-workers.sha256"
order_service=boomer-youzan-order-sync.service
order_timer=boomer-youzan-order-sync.timer
unit_dir=/etc/systemd/system
required_files=(
  src/hooks/use-sku-covers.ts
  src/hooks/use-sku-covers.test.ts
  src/lib/image.ts
  src/lib/image.test.ts
  src/lib/sku-image-display.test.ts
  src/lib/youzan-sale.server.ts
  src/lib/youzan-sale.test.ts
  src/lib/youzan-sync/queue-regression.test.mjs
  src/lib/youzan.functions.ts
  src/routes/api/public/hooks/youzan-order-sync.ts
  src/routes/inventory.skus.index.tsx
  src/routes/m.skus.index.tsx
  src/routes/shop-mgmt.products.tsx
  scripts/run-youzan-order-sync.mjs
  scripts/run-youzan-order-sync.test.mjs
  scripts/test-commit-sale-last-unit.mjs
  supabase/migrations/20260927114225_commit_sale_last_unit_delist.sql
  supabase/migrations/20260927114320_youzan_order_fast_schedule.sql
  infra/tencent/boomer-youzan-order-sync.service
  infra/tencent/boomer-youzan-order-sync.timer
  scripts/deploy-product-sale-repair-20260927.sh
  scripts/deploy-product-sale-repair-20260927.test.mjs
)
case "${1:-}" in prepare|publish) mode=$1 ;; *) echo 'Usage: prepare | publish' >&2; exit 2 ;; esac
[[ "$(readlink -f "$base/current")" == "$old" && -f "$workers" ]] || exit 1
exec 9>/var/lock/boomer-erp-product-sale-repair.lock
flock -n 9

check_archive() {
  local listing entry required found
  listing=$(tar -tzf "$archive") || return 1
  # Reject symlinks, hardlinks and special files even when their names are allowed.
  tar -tvzf "$archive" | awk 'substr($1,1,1)!="-" && substr($1,1,1)!="d" {bad=1} END {exit bad}' || return 1
  while IFS= read -r entry; do
    entry=${entry#./}
    [[ "$entry" == . || -z "$entry" ]] && continue
    found=0
    for required in "${required_files[@]}"; do
      if [[ "$entry" == "$required" || ( "$entry" == */ && "$required" == "$entry"* ) ]]; then found=1; break; fi
    done
    if [[ "$found" != 1 ]]; then echo "Unexpected archive entry: $entry" >&2; return 1; fi
  done <<< "$listing"
  for required in "${required_files[@]}"; do
    if ! printf '%s\n' "$listing" | sed 's@^\./@@' | grep -Fx "$required" >/dev/null; then
      echo "Missing archive entry: $required" >&2; return 1
    fi
  done
}
check_dependencies() {
  # Resolve from scripts, preserving the old release's isolated PGlite symlink.
  (cd "$old" && node --input-type=module <<'DEPENDENCIES'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(pathToFileURL(resolve('scripts/test-commit-sale-last-unit.mjs')));
assert.equal(typeof require('@electric-sql/pglite').PGlite,'function');
assert.equal(typeof createRequire(require.resolve('vite'))('esbuild').build,'function');
DEPENDENCIES
  )
}
ready() {
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$1/api/public/handheld/openapi.json" -o /dev/null; then return; fi
    sleep 2
  done
  return 1
}
verify_public() {
  timeout 120s node --env-file=.env scripts/verify-listing-content-live.mjs "$1"
  timeout 120s node --env-file=.env scripts/verify-custom-transfers-live.mjs "$1"
}
verify_order_guard() {
  timeout 60s node --env-file=.env --input-type=module - "$1" "$2" <<'ORDER_GUARD'
import assert from 'node:assert/strict';
const [base,mode]=process.argv.slice(2);
assert.ok(mode==='candidate'||mode==='public');
if(mode==='candidate') assert.equal(base,'http://127.0.0.1:3006');
else assert.equal(base,'https://erp.boomeroff.com');
for(const action of ['enqueue','run']) {
  const headers={'Content-Type':'application/json'};
  if(mode==='candidate') {
    assert.ok(process.env.SUPABASE_SERVICE_ROLE_KEY);
    headers.Authorization=`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  }
  const r=await fetch(`${base}/api/public/hooks/youzan-order-sync`,{
    method:'POST',headers,body:JSON.stringify({action,days:1,slices:1,max_pages:1}),
    redirect:'error',signal:AbortSignal.timeout(20000),
  });
  assert.equal(r.status,mode==='candidate'?503:401,`Order ${action} guard failed`);
  const data=await r.json();
  assert.equal(data.code,mode==='candidate'?'worker_disabled':'unauthorized');
}
console.log(JSON.stringify({orderGuards:'passed',mode,ordersTriggered:false}));
ORDER_GUARD
}
verify_candidate() {
  ready 3006
  timeout 90s node --env-file=.env scripts/verify-youzan-worker-guards.mjs http://127.0.0.1:3006 --candidate
  verify_order_guard http://127.0.0.1:3006 candidate
  verify_public http://127.0.0.1:3006
}
start_production() {
  # Both releases have fenced image workers. Never inject an empty image flag.
  env -u HANDHELD_RELEASE_WORKER_ENABLED -u HANDHELD_ITEM_SYNC_WORKER_ENABLED \
    -u YOUZAN_STOCK_WORKER_ENABLED -u YOUZAN_IMAGE_REFRESH_WORKER_ENABLED \
    -u YOUZAN_ORDER_SYNC_WORKER_ENABLED -u ERP_WORKER_ENV_FILE \
    HANDHELD_LISTING_IMAGE_WORKER_ENABLED=true APP_DIR="$1" ERP_PORT=3005 \
    pm2 start "$1/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$1" --interpreter bash --time >/dev/null
}
run_regressions() {
  timeout 180s node --input-type=module <<'BUNDLE_TESTS'
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite'))('esbuild');
const dir=await mkdtemp(resolve('.product-sale-tests-'));
try {
  const outfile=resolve(dir,'tests.mjs');
  await build({stdin:{contents:[
    'src/lib/image.test.ts','src/lib/sku-image-display.test.ts',
    'src/hooks/use-sku-covers.test.ts','src/lib/youzan-sale.test.ts',
    'src/lib/youzan-sync/cursor.test.ts',
  ].map(path=>`import "./${path}";`).join('\n'),resolveDir:process.cwd(),loader:'ts'},
    outfile,bundle:true,platform:'node',format:'esm',packages:'external',ignoreAnnotations:true,
    banner:{js:'globalThis.fetch=async()=>{throw Error("Offline regression forbids network access");};'}});
  const result=spawnSync(process.execPath,['--test',outfile],{stdio:'inherit'});
  if(result.error||result.status!==0) throw Error('Product/sale regression failed');
} finally {await rm(dir,{recursive:true,force:true});}
BUNDLE_TESTS
  for regression in scripts/run-youzan-order-sync.test.mjs scripts/test-commit-sale-last-unit.mjs \
    src/lib/youzan-sync/queue-regression.test.mjs scripts/deploy-product-sale-repair-20260927.test.mjs; do
    timeout 120s node --input-type=module - "$regression" <<'LOCAL_TEST'
globalThis.fetch=async()=>{throw Error('Offline regression forbids network access');};
await import(`./${process.argv[2]}`);
LOCAL_TEST
  done
}
install_order_timer() {
  install -m 644 "infra/tencent/$order_service" "$unit_dir/$order_service"
  install -m 644 "infra/tencent/$order_timer" "$unit_dir/$order_timer"
  systemctl daemon-reload
  systemctl enable --now "$order_timer" >/dev/null
  systemctl is-enabled --quiet "$order_timer"
  systemctl is-active --quiet "$order_timer"
}
publish_cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [[ "$rollback" == 1 ]]; then
    if [[ "$order_units_touched" == 1 ]]; then
      # Stop the new runner before returning current to a release without it.
      systemctl disable --now "$order_timer" >/dev/null 2>&1
      systemctl stop "$order_service" >/dev/null 2>&1
      if systemctl is-active --quiet "$order_timer" || systemctl is-active --quiet "$order_service"; then
        echo 'WARNING: new order unit still active; inspect immediately' >&2
      fi
      rm -f "$unit_dir/$order_service" "$unit_dir/$order_timer"
      systemctl daemon-reload
    fi
    pm2 delete boomer-off-buddy >/dev/null 2>&1
    if start_production "$old" && ready 3005 && ln -sfn "$old" "$base/current" && pm2 save >/dev/null; then
      echo "rolled_back=$old listing_image_worker=true" >&2
    else echo "ROLLBACK FAILED: inspect boomer-off-buddy; retained release=$old" >&2; fi
    status=1
  fi
  pm2 delete "$candidate" >/dev/null 2>&1
  if ! sha256sum --check --status "$worker_hash"; then echo 'workers.env changed externally; inspect' >&2; status=1; fi
  exit "$status"
}

case "$mode" in
  prepare)
    [[ ! -e "$release" && -f "$archive" ]] || exit 1
    [[ -z "$(ss -Hlt 'sport = :3006')" ]] || { echo 'Candidate port occupied' >&2; exit 1; }
    if pm2 describe "$candidate" >/dev/null 2>&1; then echo 'Candidate exists; inspect first' >&2; exit 1; fi
    check_archive
    check_dependencies
    mkdir -p "$release"
    cp -a "$old/." "$release/"
    cd "$release"
    sha256sum "$workers" > "$worker_hash"
    tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$release"
    candidate_started=0
    prepare_cleanup() {
      status=$?
      trap - EXIT
      if [[ "$status" != 0 && "$candidate_started" == 1 ]]; then pm2 delete "$candidate" >/dev/null 2>&1 || true; fi
      exit "$status"
    }
    trap prepare_cleanup EXIT
    run_regressions
    NODE_OPTIONS=--max-old-space-size=3072 timeout 1200s npm run build:tencent > /tmp/boomer-product-sale-repair-build.log 2>&1
    candidate_started=1
    HANDHELD_RELEASE_WORKER_ENABLED=false HANDHELD_ITEM_SYNC_WORKER_ENABLED=false \
      HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false YOUZAN_STOCK_WORKER_ENABLED=false \
      YOUZAN_IMAGE_REFRESH_WORKER_ENABLED=false YOUZAN_ORDER_SYNC_WORKER_ENABLED=false \
      APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" \
      --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
    verify_candidate
    sha256sum --check --status "$worker_hash"
    sha256sum "${required_files[@]}" > "$stamp"
    find .output -type f -print0 | sort -z | xargs -0 sha256sum >> "$stamp"
    echo "candidate_ready=$release (not published)"
    ;;
  publish)
    [[ "${PRODUCT_SALE_MIGRATIONS_CONFIRMED:-}" == 1 ]] || {
      echo 'Publish blocked: main must confirm both reviewed migrations via PRODUCT_SALE_MIGRATIONS_CONFIRMED=1' >&2; exit 1;
    }
    cd "$release"
    [[ -f "$stamp" && -f "$worker_hash" ]] || exit 1
    sha256sum --check --status "$stamp"
    sha256sum --check --status "$worker_hash"
    # Only install new units; never overwrite an existing timer or its configuration.
    [[ ! -e "$unit_dir/$order_service" && ! -L "$unit_dir/$order_service" && ! -e "$unit_dir/$order_timer" && ! -L "$unit_dir/$order_timer" ]] || exit 1
    if systemctl is-active --quiet "$order_timer" || systemctl is-active --quiet "$order_service" || systemctl is-enabled --quiet "$order_timer"; then
      echo 'Order unit already exists/active; inspect before publish' >&2; exit 1;
    fi
    verify_candidate
    [[ "$(readlink -f "$base/current")" == "$old" ]] || exit 1
    rollback=1
    order_units_touched=0
    trap publish_cleanup EXIT
    pm2 delete boomer-off-buddy >/dev/null
    start_production "$release"
    ready 3005
    verify_public https://erp.boomeroff.com
    timeout 90s node --env-file=.env scripts/verify-youzan-worker-guards.mjs https://erp.boomeroff.com
    verify_order_guard https://erp.boomeroff.com public
    sha256sum --check --status "$worker_hash"
    ln -sfn "$release" "$base/current"
    pm2 delete "$candidate" >/dev/null
    pm2 save >/dev/null
    # Last side effect: enable only the new order timer. Rollback stays armed until verified.
    order_units_touched=1
    install_order_timer
    sha256sum --check --status "$worker_hash"
    rollback=0
    echo "published=$release rollback=$old listing_image_worker=true workers_env=unchanged"
    ;;
esac
