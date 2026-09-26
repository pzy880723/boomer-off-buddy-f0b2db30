#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/item-delete-guard-20260926"
release="$base/releases/release-worker-recovery-20260926"
candidate=boomer-release-worker-candidate
[[ "$(readlink -f "$base/current")" == "$old" ]]
[[ ! -e "$release" && ! -e /etc/boomer-erp/workers.env ]]
[[ -z "$(ss -Hlt 'sport = :3006')" ]]
mkdir -p "$release"
# Only the launcher changes: keep the verified server build and all live-only fixes.
cp -a "$old/." "$release/"
cd "$release"
git apply --check /tmp/boomer-release-worker-recovery.patch
git apply /tmp/boomer-release-worker-recovery.patch
node --test scripts/run-tencent-erp.test.mjs
bash -n scripts/run-tencent-erp.sh
install -d -m 755 /etc/boomer-erp
install -m 644 scripts/tencent-workers.env.example /etc/boomer-erp/workers.env
rollback_needed=0
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$result" != 0 && "$rollback_needed" == 1 ]]; then
    pm2 delete boomer-off-buddy >/dev/null 2>&1 || true
    HANDHELD_RELEASE_WORKER_ENABLED=true HANDHELD_ITEM_SYNC_WORKER_ENABLED=true APP_DIR="$old" ERP_PORT=3005 pm2 start "$old/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$old" --interpreter bash --time >/dev/null
    ln -sfn "$old" "$base/current"
    pm2 save >/dev/null
  fi
  pm2 delete "$candidate" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
check() {
  local port="$1" ready=0
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/public/handheld/openapi.json" -o /dev/null; then ready=1; break; fi
    sleep 2
  done
  [[ "$ready" == 1 ]]
}
APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
check 3006
node --env-file=.env --input-type=module -e '
  for (const endpoint of ["handheld-release-worker", "handheld-item-sync-worker"]) {
    const r=await fetch(`http://127.0.0.1:3006/api/public/hooks/${endpoint}`, {method:"POST",headers:{Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
    const b=await r.json(); if(r.status!==503 || b.code!=="worker_disabled") throw Error(`Unsafe candidate ${endpoint}`);
  }
  console.log("Candidate workers safely disabled");'
[[ "$(readlink -f "$base/current")" == "$old" ]]
rollback_needed=1
pm2 delete boomer-off-buddy >/dev/null
APP_DIR="$release" ERP_PORT=3005 pm2 start "$release/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$release" --interpreter bash --time >/dev/null
check 3005
node --env-file=.env scripts/verify-item-delete-live.mjs https://erp.boomeroff.com
ln -sfn "$release" "$base/current"
pm2 save >/dev/null
rollback_needed=0
echo "release=$release previous=$old"
