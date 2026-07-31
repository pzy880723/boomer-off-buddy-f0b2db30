#!/usr/bin/env bash
set -euo pipefail

platform_env="${BOOMER_PLATFORM_ENV:-/etc/boomer-data-platform.env}"
source_env="${BOOMER_OPEN_ENV:-/etc/boomer-open.env}"
migration_root="${BOOMER_MIGRATION_ROOT:-/opt/boomer-data-platform/migration}"

for file in "$platform_env" "$source_env"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing environment file: ${file}" >&2
    exit 1
  fi
done

set -a
# shellcheck disable=SC1090
source "$platform_env"
# shellcheck disable=SC1090
source "$source_env"
set +a

export BOOMER_OPEN_BASE_URL="${BOOMER_OPEN_BASE_URL:-https://open.boomeroff.top}"
export BOOMER_OPEN_APP_TOKEN="$BOOMER_APP_TOKEN"
export BOOMER_OPEN_COS_BUCKET="$COS_BUCKET"
export BOOMER_OPEN_COS_REGION="${COS_REGION:-ap-shanghai}"
export TARGET_DATABASE_URL="postgresql://postgres.${POOLER_TENANT_ID}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/postgres?sslmode=disable"
export TARGET_DATABASE_SSL=false
export DRY_RUN=false
export SYNC_STATE_FILE="${SYNC_STATE_FILE:-/srv/boomer-data/sync/boomer-open.sha256}"

cd "$migration_root"
node migrate-boomer-open.mjs
