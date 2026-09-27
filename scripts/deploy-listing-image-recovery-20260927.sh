#!/usr/bin/env bash
# Run prepare and publish separately, only after main approves the packaged fix.
# No migrations, job replay, worker configuration changes or product mutations.
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/listing-image-detection-20260927"
release="$base/releases/listing-image-recovery-20260927"
candidate=boomer-listing-image-recovery-candidate
archive=/tmp/boomer-listing-image-recovery-20260927.tar.gz
workers=/etc/boomer-erp/workers.env
stamp="$release/.listing-image-recovery-ready"
worker_hash="$release/.listing-image-recovery-workers.sha256"
required_files=(
  src/server/handheld-listing-image-jobs.server.ts
  src/server/product-content-image-jobs.test.ts
  scripts/test-listing-image-recovery.mjs
  supabase/migrations/20260927092334_handheld_listing_image_recovery.sql
)

case "${1:-}" in prepare|resume-prepare|publish) mode=$1 ;; *) echo 'Usage: prepare | resume-prepare | publish' >&2; exit 2 ;; esac
[[ "$(readlink -f "$base/current")" == "$old" ]]
[[ -f "$workers" ]]
exec 9>/var/lock/boomer-erp-listing-image-recovery.lock
flock -n 9

check_pglite() {
  if ! (cd "$1" && node --input-type=module - "${2:-}" <<'PGLITE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
globalThis.fetch=async()=>{throw Error('Dependency check forbids network access');};
const require=createRequire(pathToFileURL(resolve('scripts/test-listing-image-recovery.mjs')));
const entry=realpathSync(require.resolve('@electric-sql/pglite'));
const isolated=process.argv[2];
if(isolated) {
  assert.equal(realpathSync('scripts/node_modules'),isolated,'Test dependencies must use the isolated runtime');
  assert.ok(entry.startsWith(`${isolated}/@electric-sql/pglite${sep}`),'PGlite must resolve inside the isolated runtime');
}
const {PGlite}=await import(pathToFileURL(entry).href);
assert.equal(typeof PGlite,'function','PGlite export missing');
PGLITE
  ); then
    echo "Missing offline SQL test dependency in $1: provide complete @electric-sql/pglite package before retry" >&2
    return 1
  fi
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
verify_candidate() {
  ready 3006
  # Service-role requests are allowed only on the disabled candidate, never production.
  timeout 90s node --env-file=.env scripts/verify-youzan-worker-guards.mjs http://127.0.0.1:3006 --candidate
  verify_public http://127.0.0.1:3006
}
verify_schema() {
  # Existence gate only; main must review/apply this exact migration through Lovable.
  # GET OpenAPI is read-only. Never probe claim/finish by invoking either RPC.
  timeout 45s node --env-file=.env --input-type=module <<'SCHEMA'
import assert from 'node:assert/strict';
const origin=process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(origin && key, 'Protected database configuration required');
const response=await fetch(`${origin.replace(/\/$/, '')}/rest/v1/`, {
  headers:{apikey:key,Authorization:`Bearer ${key}`,Accept:'application/openapi+json'},
  redirect:'error',signal:AbortSignal.timeout(30000),
});
assert.equal(response.status,200,'Read-only schema discovery failed');
const schema=await response.json();
for(const rpc of ['handheld_listing_image_claim','handheld_listing_image_finish'])
  assert.ok(schema.paths?.[`/rpc/${rpc}`]?.post, `Reviewed migration not exposed: ${rpc}`);
const columns=schema.definitions?.inv_listing_image_jobs?.properties;
assert.ok(columns?.claim_token && columns?.lease_until,'Reviewed recovery columns not exposed');
console.log(JSON.stringify({recoverySchemaExists:true,probe:'GET OpenAPI',databaseWrites:0}));
SCHEMA
}
start_production() {
  # The host-owned workers.env, not inherited shell overrides, controls production.
  # Old code bypasses claim fencing; rollback keeps only its image worker disabled.
  local target=$1
  set -- APP_DIR="$target" ERP_PORT=3005
  if [[ "$target" == "$old" ]]; then set -- HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false "$@"; fi
  env -u HANDHELD_RELEASE_WORKER_ENABLED -u HANDHELD_ITEM_SYNC_WORKER_ENABLED \
    -u HANDHELD_LISTING_IMAGE_WORKER_ENABLED -u YOUZAN_STOCK_WORKER_ENABLED \
    -u YOUZAN_IMAGE_REFRESH_WORKER_ENABLED -u ERP_WORKER_ENV_FILE \
    "$@" pm2 start "$target/scripts/run-tencent-erp.sh" \
    --name boomer-off-buddy --cwd "$target" --interpreter bash --time >/dev/null
}

case "$mode" in
  prepare|resume-prepare)
    [[ -z "$(ss -Hlt 'sport = :3006')" ]] || { echo 'Candidate port 3006 is occupied' >&2; exit 1; }
    if pm2 describe "$candidate" >/dev/null 2>&1; then echo 'Candidate already exists; inspect before retry' >&2; exit 1; fi
    if [[ "$mode" == resume-prepare ]]; then
      [[ -d "$release" && ! -L "$release" && -d "$release/node_modules" ]] || {
        echo 'Resume requires the existing recovery release and its dependencies' >&2
        exit 1
      }
      [[ -f "$release/.env" && -f "$worker_hash" ]] || exit 1
      sha256sum --check --status "$worker_hash" || exit 1
      for required in "${required_files[@]}"; do [[ -f "$release/$required" ]] || exit 1; done
      check_pglite "$release" /tmp/boomer-recovery-test-runtime/node_modules || exit 1
    else
    [[ ! -e "$release" && -f "$archive" ]]
    check_pglite "$old" || exit 1
    # Main applies the reviewed SQL via Lovable. Packaging it does not execute it.
    tar -tzf "$archive" | while IFS= read -r entry; do
      case "${entry#./}" in
        ''|.|src/|src/server/|scripts/|supabase/|supabase/migrations/) ;;
        src/server/handheld-listing-image-jobs.server.ts|src/server/product-content-image-jobs.test.ts|scripts/test-listing-image-recovery.mjs|supabase/migrations/20260927092334_handheld_listing_image_recovery.sql|scripts/deploy-listing-image-recovery-20260927.sh) ;;
        *) echo "Unexpected hotfix archive entry: $entry" >&2; exit 1 ;;
      esac
    done
    for required in "${required_files[@]}"; do
      tar -tzf "$archive" | sed 's@^\./@@' | grep -Fx "$required" >/dev/null
    done
    mkdir -p "$release"
    cp -a "$old/." "$release/"
    cd "$release"
    sha256sum "$workers" > "$worker_hash"
    tar -xzf "$archive" -C "$release"
    fi
    cd "$release"
    # A failed resumed build must not leave a previous ready stamp publishable.
    rm -f "$stamp"
    candidate_started=0
    prepare_cleanup() {
      status=$?
      trap - EXIT
      if [[ "$status" != 0 && "$candidate_started" == 1 ]]; then pm2 delete "$candidate" >/dev/null 2>&1 || true; fi
      exit "$status"
    }
    trap prepare_cleanup EXIT
    # Bundle local tests with the already-installed Vite/esbuild; no npm install or network tests.
    node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const dir = await mkdtemp(resolve('.listing-image-recovery-tests-'));
try {
  const outfile = resolve(dir, 'tests.mjs');
  await build({ stdin: { contents: 'import "./src/server/product-content-image-jobs.test.ts"; import "./src/server/handheld-ai-image-timeout.test.ts"; import "./src/server/listing-image-safety.test.ts"; import "./src/server/listing-image-worker-hook.test.ts";',
    resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    ignoreAnnotations: true,
    banner: { js: 'globalThis.fetch = async () => { throw Error("Hotfix regression forbids live network calls"); };' } });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw Error('Recovery/detector/worker-guard regression failed');
} finally { await rm(dir, { recursive: true, force: true }); }
NODE
    # In-memory PGlite only. No production SQL command or environment-file loading.
    timeout 120s node --input-type=module -e 'globalThis.fetch=async()=>{throw Error("SQL regression forbids network access");}; await import("./scripts/test-listing-image-recovery.mjs");'
    NODE_OPTIONS=--max-old-space-size=3072 timeout 1200s npm run build:tencent > /tmp/boomer-listing-image-recovery-build.log 2>&1
    candidate_started=1
    APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" \
      --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
    verify_candidate
    sha256sum --check --status "$worker_hash"
    sha256sum "${required_files[@]}" > "$stamp"
    echo "candidate_ready=$release (not published)"
    ;;
  publish)
    # Operator must stop old timer/inline work and verify DB-side requests drained.
    # Killing Node or waiting for its lease alone does not cancel an old apply RPC.
    if [[ "${LEGACY_IMAGE_WORKER_DRAIN_CONFIRMED:-}" != 1 ]]; then
      echo 'Publish blocked: confirm old image worker entries stopped and DB requests drained; set LEGACY_IMAGE_WORKER_DRAIN_CONFIRMED=1' >&2
      exit 1
    fi
    cd "$release"
    [[ -f "$stamp" && -f "$worker_hash" ]]
    sha256sum --check --status "$stamp"
    sha256sum --check --status "$worker_hash"
    verify_candidate
    verify_schema
    [[ "$(readlink -f "$base/current")" == "$old" ]]
    rollback=1
    cleanup() {
      status=$?
      trap - EXIT
      set +e
      if [[ "$rollback" == 1 ]]; then
        pm2 delete boomer-off-buddy >/dev/null 2>&1
        if start_production "$old" && ready 3005 && ln -sfn "$old" "$base/current" && pm2 save >/dev/null; then
          echo "rolled_back=$old listing_image_worker=disabled (runtime override; workers.env unchanged)" >&2
        else echo "ROLLBACK FAILED: inspect boomer-off-buddy; retained release=$old" >&2; fi
        status=1
      fi
      pm2 delete "$candidate" >/dev/null 2>&1
      # Never restore/rewrite worker flags even on rollback. Report unexpected concurrent changes.
      if ! sha256sum --check --status "$worker_hash"; then echo 'workers.env changed externally; inspect before retry' >&2; status=1; fi
      exit "$status"
    }
    trap cleanup EXIT
    pm2 delete boomer-off-buddy >/dev/null
    start_production "$release"
    ready 3005
    verify_public https://erp.boomeroff.com
    timeout 90s node --env-file=.env scripts/verify-youzan-worker-guards.mjs https://erp.boomeroff.com
    sha256sum --check --status "$worker_hash"
    ln -sfn "$release" "$base/current"
    pm2 delete "$candidate" >/dev/null
    pm2 save >/dev/null
    rollback=0
    echo "published=$release rollback=$old workers_env=unchanged"
    ;;
esac
