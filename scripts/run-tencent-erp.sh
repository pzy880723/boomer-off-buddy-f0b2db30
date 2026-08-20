#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BIND_HOST="${ERP_BIND_HOST:-127.0.0.1}"
BIND_PORT="${ERP_PORT:-3005}"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env" >&2
  exit 1
fi

LEGACY_WRANGLER_CONFIG="$APP_DIR/.output/server/wrangler.json"
DIST_SERVER_ENTRY="$APP_DIR/dist/server/server.js"
DIST_ASSETS_DIR="$APP_DIR/dist/client"

if [[ ! -f "$LEGACY_WRANGLER_CONFIG" && ! -f "$DIST_SERVER_ENTRY" ]]; then
  echo "Missing ERP build output. Run npm run build before starting ERP." >&2
  exit 1
fi

set -a
source "$APP_DIR/.env"
set +a

cd "$APP_DIR"
if [[ -f "$DIST_SERVER_ENTRY" ]]; then
  exec "$APP_DIR/node_modules/.bin/wrangler" dev "$DIST_SERVER_ENTRY" \
    --env-file "$APP_DIR/.env" \
    --ip "$BIND_HOST" \
    --port "$BIND_PORT" \
    --assets "$DIST_ASSETS_DIR" \
    --local \
    --log-level info
fi

exec "$APP_DIR/node_modules/.bin/wrangler" dev \
  --config "$LEGACY_WRANGLER_CONFIG" \
  --env-file "$APP_DIR/.env" \
  --ip "$BIND_HOST" \
  --port "$BIND_PORT" \
  --assets "$APP_DIR/.output/public" \
  --local \
  --log-level info
