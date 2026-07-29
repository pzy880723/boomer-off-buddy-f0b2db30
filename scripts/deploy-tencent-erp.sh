#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ERP_BASE_URL="${ERP_BASE_URL:-https://erp.boomeroff.com}"

cd "$APP_DIR"

npm install --no-package-lock --ignore-scripts=false
npm run test:login-hydration
npm run build

test -f .output/server/wrangler.json
test -d .output/public

pm2 startOrReload ecosystem.tencent.cjs --only boomer-off-buddy --update-env

for _ in {1..30}; do
  if curl --fail --silent --show-error "$ERP_BASE_URL/login" >/dev/null; then
    break
  fi
  sleep 1
done

node scripts/check-login-hydration.mjs "$ERP_BASE_URL"
pm2 save
