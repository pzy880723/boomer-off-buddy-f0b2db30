#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BIND_HOST="${ERP_BIND_HOST:-127.0.0.1}"
BIND_PORT="${ERP_PORT:-3005}"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.output/server/wrangler.json" ]]; then
  echo "Missing .output build. Run npm run build before starting ERP." >&2
  exit 1
fi

set -a
source "$APP_DIR/.env"
set +a

cd "$APP_DIR"
exec "$APP_DIR/node_modules/.bin/wrangler" dev \
  --config "$APP_DIR/.output/server/wrangler.json" \
  --env-file "$APP_DIR/.env" \
  --ip "$BIND_HOST" \
  --port "$BIND_PORT" \
  --assets "$APP_DIR/.output/public" \
  --local \
  --log-level info
