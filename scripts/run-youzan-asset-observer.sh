#!/usr/bin/env bash
set -euo pipefail
app="/var/www/boomer-erp/current"
set -a
source "$app/.env"
source /opt/youzan-proxy/.env
export YOUZAN_PROXY_URL=http://127.0.0.1:8787/forward
export YOUZAN_PROXY_TOKEN="$PROXY_TOKEN"
export YOUZAN_ASSET_OBSERVER_ENABLED=true
unset PROXY_TOKEN
set +a
cd "$app"
exec node scripts/.youzan-asset-observer.mjs
