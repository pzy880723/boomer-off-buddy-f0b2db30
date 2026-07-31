#!/usr/bin/env bash
set -euo pipefail

platform_root="${BOOMER_PLATFORM_ROOT:-/srv/boomer-data/supabase}"
runtime_root="${platform_root}/runtime"
backup_root="${BOOMER_BACKUP_ROOT:-/srv/boomer-data/backups}"
retention_days="${BOOMER_BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_root}/${timestamp}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [[ ! -f "${runtime_root}/docker-compose.yml" ]]; then
  echo "Missing Supabase runtime: ${runtime_root}" >&2
  exit 1
fi

mkdir -p "$target"
chmod 700 "$backup_root" "$target"

cd "$runtime_root"
docker compose exec -T db pg_dumpall \
  -U postgres \
  --roles-only \
  >"${target}/roles.sql"
docker compose exec -T db pg_dump \
  -U postgres \
  -d postgres \
  --format=custom \
  --no-owner \
  --no-privileges \
  >"${target}/postgres.dump"

sha256sum "${target}/roles.sql" "${target}/postgres.dump" \
  >"${target}/SHA256SUMS"
chmod 600 "${target}/roles.sql" "${target}/postgres.dump" "${target}/SHA256SUMS"

find "$backup_root" \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -mtime "+${retention_days}" \
  -exec rm -rf -- {} +

echo "Created database backup: ${target}"
