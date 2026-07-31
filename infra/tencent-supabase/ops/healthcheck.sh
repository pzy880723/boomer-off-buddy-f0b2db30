#!/usr/bin/env bash
set -euo pipefail

env_file="${BOOMER_PLATFORM_ENV:-/etc/boomer-data-platform.env}"
platform_root="${BOOMER_PLATFORM_ROOT:-/srv/boomer-data/supabase}"
runtime_root="${platform_root}/runtime"
minimum_free_gb="${BOOMER_MINIMUM_FREE_GB:-20}"

if [[ ! -f "$env_file" ]]; then
  echo "Missing environment file: ${env_file}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

cd "$runtime_root"

unhealthy="$(
  docker compose ps --format json |
    jq -r 'select(.Health != "" and .Health != "healthy") | .Service + ":" + .Health'
)"
if [[ -n "$unhealthy" ]]; then
  echo "Unhealthy Supabase services:" >&2
  echo "$unhealthy" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:${KONG_HTTP_PORT}/auth/v1/health" \
  -H "apikey: ${ANON_KEY}" \
  >/dev/null
curl -fsS \
  "http://127.0.0.1:${KONG_HTTP_PORT}/rest/v1/store_development_projects?select=id&limit=1" \
  -H "apikey: ${ANON_KEY}" \
  >/dev/null

docker compose exec -T db psql \
  -U postgres \
  -d postgres \
  -Atqc "select 1" \
  >/dev/null

free_gb="$(df -Pk "$BOOMER_POSTGRES_DATA" | awk 'NR == 2 { print int($4 / 1024 / 1024) }')"
if (( free_gb < minimum_free_gb )); then
  echo "Database disk space is low: ${free_gb} GB free." >&2
  exit 1
fi

echo "BOOMER data platform healthy; ${free_gb} GB free."
