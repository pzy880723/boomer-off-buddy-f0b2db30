#!/usr/bin/env bash
# Run prepare and publish separately, only after main approves the packaged fix.
# No migrations, job replay, worker configuration changes or product mutations.
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/youzan-listing-sync-20260927"
release="$base/releases/listing-image-detection-20260927"
candidate=boomer-listing-image-detection-candidate
archive=/tmp/boomer-listing-image-detection-20260927.tar.gz
workers=/etc/boomer-erp/workers.env
stamp="$release/.listing-image-detection-ready"
worker_hash="$release/.listing-image-detection-workers.sha256"

case "${1:-}" in prepare|publish) mode=$1 ;; *) echo 'Usage: prepare | publish' >&2; exit 2 ;; esac
[[ "$(readlink -f "$base/current")" == "$old" ]]
[[ -f "$workers" ]]
exec 9>/var/lock/boomer-erp-listing-image-detection.lock
flock -n 9

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
start_production() {
  # The host-owned workers.env, not inherited shell overrides, controls production.
  env -u HANDHELD_RELEASE_WORKER_ENABLED -u HANDHELD_ITEM_SYNC_WORKER_ENABLED \
    -u HANDHELD_LISTING_IMAGE_WORKER_ENABLED -u YOUZAN_STOCK_WORKER_ENABLED \
    -u YOUZAN_IMAGE_REFRESH_WORKER_ENABLED -u ERP_WORKER_ENV_FILE \
    APP_DIR="$1" ERP_PORT=3005 pm2 start "$1/scripts/run-tencent-erp.sh" \
    --name boomer-off-buddy --cwd "$1" --interpreter bash --time >/dev/null
}

case "$mode" in
  prepare)
    [[ ! -e "$release" && -f "$archive" && -z "$(ss -Hlt 'sport = :3006')" ]]
    if pm2 describe "$candidate" >/dev/null 2>&1; then echo 'Candidate already exists; inspect before retry' >&2; exit 1; fi
    # The repair utility may travel with the fix, but is NEVER executed here.
    tar -tzf "$archive" | while IFS= read -r entry; do
      case "${entry#./}" in
        ''|.|src/|src/server/|scripts/) ;;
        src/server/listing-image-safety.server.ts|src/server/listing-image-safety.test.ts|scripts/deploy-listing-image-detection-20260927.sh|scripts/repair-padded-listing-images-20260927.ts) ;;
        *) echo "Unexpected hotfix archive entry: $entry" >&2; exit 1 ;;
      esac
    done
    for required in src/server/listing-image-safety.server.ts src/server/listing-image-safety.test.ts; do
      tar -tzf "$archive" | sed 's@^\./@@' | grep -Fx "$required" >/dev/null
    done
    mkdir -p "$release"
    cp -a "$old/." "$release/"
    cd "$release"
    sha256sum "$workers" > "$worker_hash"
    tar -xzf "$archive" -C "$release"
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
const dir = await mkdtemp(resolve('.listing-image-detection-tests-'));
try {
  const outfile = resolve(dir, 'tests.mjs');
  await build({ stdin: { contents: 'import "./src/server/listing-image-safety.test.ts"; import "./src/server/listing-image-worker-hook.test.ts";',
    resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    ignoreAnnotations: true,
    banner: { js: 'globalThis.fetch = async () => { throw Error("Hotfix regression forbids live network calls"); };' } });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw Error('Detector/worker-guard regression failed');
} finally { await rm(dir, { recursive: true, force: true }); }
NODE
    NODE_OPTIONS=--max-old-space-size=3072 npm run build:tencent > /tmp/boomer-listing-image-detection-build.log 2>&1
    candidate_started=1
    APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" \
      --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
    verify_candidate
    sha256sum --check --status "$worker_hash"
    sha256sum src/server/listing-image-safety.server.ts src/server/listing-image-safety.test.ts > "$stamp"
    echo "candidate_ready=$release (not published)"
    ;;
  publish)
    cd "$release"
    [[ -f "$stamp" && -f "$worker_hash" ]]
    sha256sum --check --status "$stamp"
    sha256sum --check --status "$worker_hash"
    verify_candidate
    [[ "$(readlink -f "$base/current")" == "$old" ]]
    rollback=1
    cleanup() {
      status=$?
      trap - EXIT
      set +e
      if [[ "$rollback" == 1 ]]; then
        pm2 delete boomer-off-buddy >/dev/null 2>&1
        if start_production "$old" && ready 3005 && ln -sfn "$old" "$base/current" && pm2 save >/dev/null; then
          echo "rolled_back=$old" >&2
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
