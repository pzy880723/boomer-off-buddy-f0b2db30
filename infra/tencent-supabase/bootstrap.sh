#!/usr/bin/env bash
set -euo pipefail

env_file="${BOOMER_PLATFORM_ENV:-/etc/boomer-data-platform.env}"
install_root="${BOOMER_PLATFORM_ROOT:-/srv/boomer-data/supabase}"
source_root="${install_root}/source"
runtime_root="${install_root}/runtime"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

for command in git docker openssl jq curl; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

docker compose version >/dev/null

if [[ ! -f "$env_file" ]]; then
  echo "Missing environment file: $env_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ -z "${SUPABASE_REF:-}" ]]; then
  echo "SUPABASE_REF must be pinned to a reviewed tag or commit." >&2
  exit 1
fi

required_values=(
  SUPABASE_PUBLIC_URL API_EXTERNAL_URL SITE_URL PROXY_DOMAIN
  KONG_HTTP_PORT KONG_HTTPS_PORT POSTGRES_PORT
  POOLER_PROXY_PORT_TRANSACTION BOOMER_POSTGRES_DATA
  POSTGRES_PASSWORD DASHBOARD_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY
  SECRET_KEY_BASE REALTIME_DB_ENC_KEY VAULT_ENC_KEY PG_META_CRYPTO_KEY
  LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN
  S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET POOLER_TENANT_ID
  GLOBAL_S3_BUCKET GLOBAL_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
)
for name in "${required_values[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment value: $name" >&2
    exit 1
  fi
done

"$(dirname "$0")/preflight.sh"

mkdir -p "$install_root"
mkdir -p "$BOOMER_POSTGRES_DATA"
if [[ ! -d "$source_root/.git" ]]; then
  git clone --filter=blob:none --no-checkout \
    https://github.com/supabase/supabase.git "$source_root"
fi

if ! git -C "$source_root" cat-file -e "${SUPABASE_REF}^{commit}" 2>/dev/null; then
  git -C "$source_root" fetch --depth 1 origin "$SUPABASE_REF"
fi
git -C "$source_root" sparse-checkout init --cone
git -C "$source_root" sparse-checkout set docker
git -C "$source_root" checkout --detach "$SUPABASE_REF"

rm -rf "$runtime_root.next"
mkdir -p "$runtime_root.next"
cp -a "$source_root/docker/." "$runtime_root.next/"

# Keep every variable supplied by the reviewed upstream release, then append
# the private BOOMER overrides. Docker Compose uses the last assignment.
cat "$runtime_root.next/.env.example" "$env_file" \
  >"$runtime_root.next/.env"
chmod 600 "$runtime_root.next/.env"

cat >"$runtime_root.next/docker-compose.tencent-cos.yml" <<'YAML'
services:
  kong:
    ports: !override
      - 127.0.0.1:${KONG_HTTP_PORT}:8000/tcp
      - 127.0.0.1:${KONG_HTTPS_PORT}:8443/tcp

  db:
    # The historical ERP migration contains a Lovable worker URL. Keep it
    # unreachable in the isolated target until the Tencent API is deployed.
    extra_hosts:
      - project--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app:127.0.0.1
    volumes:
      - ${BOOMER_POSTGRES_DATA}:/var/lib/postgresql/data:Z

  supavisor:
    ports: !override
      - 127.0.0.1:${POSTGRES_PORT}:5432
      - 127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION}:6543

  storage:
    environment:
      STORAGE_BACKEND: ${STORAGE_BACKEND}
      GLOBAL_S3_BUCKET: ${GLOBAL_S3_BUCKET}
      GLOBAL_S3_ENDPOINT: ${GLOBAL_S3_ENDPOINT}
      GLOBAL_S3_PROTOCOL: ${GLOBAL_S3_PROTOCOL}
      GLOBAL_S3_FORCE_PATH_STYLE: ${GLOBAL_S3_FORCE_PATH_STYLE}
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      REGION: ${REGION}
YAML

if [[ -d "$runtime_root" ]]; then
  mv "$runtime_root" "${runtime_root}.previous.$(date +%Y%m%d%H%M%S)"
fi
mv "$runtime_root.next" "$runtime_root"

cd "$runtime_root"
docker compose -f docker-compose.yml -f docker-compose.tencent-cos.yml pull
docker compose -f docker-compose.yml -f docker-compose.tencent-cos.yml up -d

echo "Waiting for the API gateway..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${KONG_HTTP_PORT}/auth/v1/health" \
    -H "apikey: ${ANON_KEY}" \
    >/dev/null 2>&1; then
    echo "Supabase-compatible stack is healthy."
    exit 0
  fi
  sleep 5
done

docker compose -f docker-compose.yml -f docker-compose.tencent-cos.yml ps
echo "Supabase stack did not become healthy in time." >&2
exit 1
