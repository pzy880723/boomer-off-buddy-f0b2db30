#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/release-worker-recovery-20260926"
release="$base/releases/custom-transfers-20260927"
candidate=boomer-custom-transfer-candidate
check() {
  local port="$1"
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/public/handheld/openapi.json" -o /dev/null; then return; fi
    sleep 2
  done
  return 1
}
if [[ "${1:-}" == prepare ]]; then
  [[ "$(readlink -f "$base/current")" == "$old" ]]
  [[ ! -e "$release" && -z "$(ss -Hlt 'sport = :3006')" ]]
  mkdir -p "$release"
  cp -a "$old/." "$release/"
  cd "$release"
  git apply --check /tmp/boomer-custom-transfers.patch
  git apply /tmp/boomer-custom-transfers.patch
  NODE_OPTIONS=--max-old-space-size=3072 npm run build:tencent > /tmp/boomer-custom-transfer-build.log 2>&1
  APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
  check 3006
  node --env-file=.env scripts/verify-custom-transfers-live.mjs http://127.0.0.1:3006
  node --env-file=.env --input-type=module -e '
    for(const endpoint of ["handheld-release-worker","handheld-item-sync-worker"]){
      const r=await fetch(`http://127.0.0.1:3006/api/public/hooks/${endpoint}`,{method:"POST",headers:{Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
      const b=await r.json(); if(r.status!==503 || b.code!=="worker_disabled")throw Error("Unsafe candidate worker");
    } console.log("Candidate workers disabled");'
  echo "candidate_ready=$release"
elif [[ "${1:-}" == publish ]]; then
  [[ "$(readlink -f "$base/current")" == "$old" ]]
  cd "$release"
  node --env-file=.env scripts/verify-custom-transfers-live.mjs http://127.0.0.1:3006
  rollback=1
  cleanup() {
    status=$?
    trap - EXIT
    if [[ "$rollback" == 1 ]]; then
      pm2 delete boomer-off-buddy >/dev/null 2>&1 || true
      APP_DIR="$old" ERP_PORT=3005 pm2 start "$old/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$old" --interpreter bash --time >/dev/null
      ln -sfn "$old" "$base/current"
      pm2 save >/dev/null
    fi
    pm2 delete "$candidate" >/dev/null 2>&1 || true
    exit "$status"
  }
  trap cleanup EXIT
  pm2 delete boomer-off-buddy >/dev/null
  APP_DIR="$release" ERP_PORT=3005 pm2 start "$release/scripts/run-tencent-erp.sh" --name boomer-off-buddy --cwd "$release" --interpreter bash --time >/dev/null
  check 3005
  node --env-file=.env scripts/verify-custom-transfers-live.mjs https://erp.boomeroff.com
  node --env-file=.env scripts/verify-item-delete-live.mjs https://erp.boomeroff.com
  ln -sfn "$release" "$base/current"
  pm2 save >/dev/null
  rollback=0
  echo "published=$release rollback=$old"
else
  echo 'Usage: prepare | publish' >&2; exit 2
fi
