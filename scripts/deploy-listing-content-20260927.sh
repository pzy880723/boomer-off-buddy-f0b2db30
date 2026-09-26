#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/custom-transfers-20260927"
release="$base/releases/listing-content-20260927"
candidate=boomer-listing-content-candidate
check() {
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 5 "http://127.0.0.1:$1/api/public/handheld/openapi.json" -o /dev/null; then return; fi
    sleep 2
  done
  return 1
}
if [[ "${1:-}" == prepare || "${1:-}" == resume-prepare ]]; then
  [[ "$(readlink -f "$base/current")" == "$old" ]]
  [[ -z "$(ss -Hlt 'sport = :3006')" ]]
  if [[ "$1" == prepare ]]; then
    [[ ! -e "$release" ]]
    mkdir -p "$release"
    cp -a "$old/." "$release/"
  else
    [[ -d "$release" ]]
  fi
  cd "$release"
  # Production has separate image-loading and dependency fixes. Preserve those,
  # regenerate generated files, and merge only the new published-content fields.
  excludes=(--exclude=bun.lock --exclude=package.json --exclude=openapi.snapshot.json
    --exclude=src/routeTree.gen.ts '--exclude=src/routes/api/public/storefront/products.$id.ts')
  git apply --check "${excludes[@]}" /tmp/boomer-listing-content.patch
  git apply --check /tmp/boomer-listing-content-runtime.patch
  git apply "${excludes[@]}" /tmp/boomer-listing-content.patch
  git apply /tmp/boomer-listing-content-runtime.patch
  # Keep the existing production dependency tree untouched; the pinned native module already exists.
  node -e 'if(require("sharp/package.json").version!=="0.35.2")throw Error("Unexpected sharp runtime")'
  node -e 'const r=require("node:module").createRequire(require.resolve("vite"));r("esbuild").buildSync({entryPoints:["scripts/gen-sdk.ts"],outfile:"scripts/.listing-sdk-gen.cjs",bundle:true,platform:"node",format:"cjs",packages:"external"})'
  node scripts/.listing-sdk-gen.cjs
  NODE_OPTIONS=--max-old-space-size=3072 npm run build:tencent > /tmp/boomer-listing-content-build.log 2>&1
  APP_DIR="$release" ERP_PORT=3006 pm2 start "$release/scripts/run-tencent-erp.sh" --name "$candidate" --cwd "$release" --interpreter bash --time >/dev/null
  check 3006
  node --env-file=.env scripts/verify-listing-content-live.mjs http://127.0.0.1:3006 --ai-probe
  node --env-file=.env --input-type=module -e '
    for(const endpoint of ["handheld-release-worker","handheld-item-sync-worker","listing-image-worker"]){
      const r=await fetch(`http://127.0.0.1:3006/api/public/hooks/${endpoint}`,{method:"POST",headers:{Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
      const b=await r.json(); if(r.status!==503 || b.code!=="worker_disabled")throw Error("Unsafe candidate worker");
    } console.log("Candidate workers disabled");'
  echo "candidate_ready=$release"
elif [[ "${1:-}" == publish ]]; then
  [[ "$(readlink -f "$base/current")" == "$old" ]]
  cd "$release"
  node --env-file=.env scripts/verify-listing-content-live.mjs http://127.0.0.1:3006
  rollback=1
  cleanup() {
    status=$?
    trap - EXIT
    if [[ "$rollback" == 1 ]]; then
      systemctl disable --now boomer-listing-image.timer >/dev/null 2>&1 || true
      systemctl stop boomer-listing-image.service >/dev/null 2>&1 || true
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
  install -m 644 infra/tencent/boomer-listing-image.service /etc/systemd/system/
  install -m 644 infra/tencent/boomer-listing-image.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl start boomer-listing-image.service
  [[ "$(systemctl show boomer-listing-image.service -p Result --value)" == success ]]
  systemctl enable --now boomer-listing-image.timer >/dev/null
  systemctl is-active --quiet boomer-listing-image.timer
  pm2 save >/dev/null
  rollback=0
  echo "published=$release rollback=$old"
else
  echo 'Usage: prepare | resume-prepare | publish' >&2; exit 2
fi
