#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ERP_BASE_URL="${ERP_BASE_URL:-https://erp.boomeroff.com}"
PROCESS_NAME="${PROCESS_NAME:-boomer-off-buddy}"
CANDIDATE_NAME="${CANDIDATE_NAME:-${PROCESS_NAME}-candidate}"
ERP_PORT="${ERP_PORT:-3005}"
CANDIDATE_PORT="${CANDIDATE_PORT:-3006}"

cd "$APP_DIR"

npm install --no-package-lock --ignore-scripts=false
npm run test:login-hydration
npm run build

if [[ ! -f .output/server/wrangler.json && ! -f dist/server/server.js ]]; then
  echo "Missing ERP server build output" >&2
  exit 1
fi
if [[ ! -d .output/public && ! -d dist/client ]]; then
  echo "Missing ERP client build output" >&2
  exit 1
fi

start_process() {
  local name="$1"
  local port="$2"

  pm2 delete "$name" >/dev/null 2>&1 || true
  ERP_BIND_HOST=127.0.0.1 ERP_PORT="$port" NODE_ENV=production \
    pm2 start "$APP_DIR/scripts/run-tencent-erp.sh" \
      --name "$name" \
      --interpreter /bin/bash \
      --update-env
}

wait_for_login() {
  local url="$1"

  for _ in {1..30}; do
    if curl --fail --silent --show-error "$url/login" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}

cleanup_candidate() {
  pm2 delete "$CANDIDATE_NAME" >/dev/null 2>&1 || true
}

trap cleanup_candidate EXIT

start_process "$CANDIDATE_NAME" "$CANDIDATE_PORT"
wait_for_login "http://127.0.0.1:$CANDIDATE_PORT"
node scripts/check-login-hydration.mjs "http://127.0.0.1:$CANDIDATE_PORT"

pm2 delete "$PROCESS_NAME" >/dev/null 2>&1 || true
start_process "$PROCESS_NAME" "$ERP_PORT"
wait_for_login "http://127.0.0.1:$ERP_PORT"
node scripts/check-login-hydration.mjs "http://127.0.0.1:$ERP_PORT"

wait_for_login "$ERP_BASE_URL"
node scripts/check-login-hydration.mjs "$ERP_BASE_URL"

cleanup_candidate
trap - EXIT
pm2 save
