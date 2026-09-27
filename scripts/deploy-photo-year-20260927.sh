#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/photo-year-evidence-20260927"
release="$base/releases/era-estimate-20260927-r2"
candidate=boomer-era-estimate-candidate
check() {
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$1/api/public/handheld/openapi.json" -o /dev/null; then return; fi
    sleep 2
  done
  return 1
}
[[ "$(readlink -f "$base/current")" == "$old" ]]
if [[ "${1:-}" == prepare ]]; then
  [[ ! -e "$release" && -z "$(ss -Hlt 'sport = :3006')" ]]
  mkdir -p "$release"
  cp -a "$old/." "$release/"
  cd "$release"
  git apply --check /tmp/boomer-era-estimate.patch
  git apply /tmp/boomer-era-estimate.patch
  NODE_OPTIONS=--max-old-space-size=3072 npm run build:tencent > /tmp/boomer-era-estimate-build.log 2>&1
  APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
  check 3006
  node --env-file=.env scripts/verify-listing-content-live.mjs http://127.0.0.1:3006
  node --env-file=.env --input-type=module -e '
    for(const endpoint of ["handheld-release-worker","handheld-item-sync-worker","listing-image-worker"]){
      const r=await fetch(`http://127.0.0.1:3006/api/public/hooks/${endpoint}`,{method:"POST",headers:{Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
      const b=await r.json(); if(r.status!==503 || b.code!=="worker_disabled")throw Error("Unsafe candidate worker");
    } console.log("Candidate workers disabled");'
  # Synthetic labels and stub audit only; run the real AI probe once, before approval.
  node --env-file=.env scripts/verify-photo-year-live.mjs
  echo "candidate_ready=$release"
elif [[ "${1:-}" == publish ]]; then
  cd "$release"
  node --env-file=.env scripts/verify-listing-content-live.mjs http://127.0.0.1:3006
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
  node --env-file=.env scripts/verify-listing-content-live.mjs https://erp.boomeroff.com
  node --env-file=.env scripts/verify-custom-transfers-live.mjs https://erp.boomeroff.com
  node --env-file=.env scripts/verify-item-delete-live.mjs https://erp.boomeroff.com
  ln -sfn "$release" "$base/current"
  systemctl is-active --quiet boomer-listing-image.timer
  pm2 save >/dev/null
  rollback=0
  echo "published=$release rollback=$old"
else
  echo 'Usage: prepare | publish' >&2
  exit 2
fi
