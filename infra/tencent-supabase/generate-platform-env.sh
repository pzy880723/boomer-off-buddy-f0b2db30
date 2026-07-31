#!/usr/bin/env bash
set -euo pipefail

target="${1:-/etc/boomer-data-platform.env}"
source_env="${BOOMER_OPEN_ENV:-/etc/boomer-open.env}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [[ -e "$target" ]]; then
  echo "Refusing to replace existing environment file: $target" >&2
  exit 1
fi

if [[ ! -f "$source_env" ]]; then
  echo "Missing Tencent COS source environment: $source_env" >&2
  exit 1
fi

for command in openssl python3; do
  command -v "$command" >/dev/null || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

set -a
# shellcheck disable=SC1090
source "$source_env"
set +a

for name in COS_BUCKET TENCENTCLOUD_SECRETID TENCENTCLOUD_SECRETKEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing $name in $source_env" >&2
    exit 1
  fi
done

jwt_secret="$(openssl rand -hex 32)"
# PostgreSQL service URLs interpolate this value without percent-encoding.
postgres_password="$(openssl rand -hex 32)"
dashboard_password="$(openssl rand -base64 24 | tr -d '\n')"
secret_key_base="$(openssl rand -base64 48 | tr -d '\n')"
realtime_db_enc_key="$(openssl rand -hex 8)"
vault_enc_key="$(openssl rand -hex 16)"
pg_meta_crypto_key="$(openssl rand -base64 24 | tr -d '\n')"
logflare_public="$(openssl rand -base64 24 | tr -d '\n')"
logflare_private="$(openssl rand -base64 24 | tr -d '\n')"
s3_protocol_id="$(openssl rand -hex 16)"
s3_protocol_secret="$(openssl rand -hex 32)"

sign_key() {
  JWT_SIGNING_SECRET="$jwt_secret" JWT_ROLE="$1" python3 - <<'PY'
import base64
import hashlib
import hmac
import json
import os
import time

def encoded(value):
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

header = encoded({"alg": "HS256", "typ": "JWT"})
payload = encoded({
    "role": os.environ["JWT_ROLE"],
    "iss": "supabase",
    "iat": int(time.time()),
    "exp": 4102444800,
})
message = f"{header}.{payload}".encode()
signature = hmac.new(
    os.environ["JWT_SIGNING_SECRET"].encode(),
    message,
    hashlib.sha256,
).digest()
print(f"{header}.{payload}." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode())
PY
}

anon_key="$(sign_key anon)"
service_role_key="$(sign_key service_role)"
temp="$(mktemp)"
trap 'rm -f "$temp"' EXIT

cat >"$temp" <<EOF
SUPABASE_PUBLIC_URL=https://data.boomeroff.top
API_EXTERNAL_URL=https://data.boomeroff.top/auth/v1
SITE_URL=https://erp.boomeroff.com
ADDITIONAL_REDIRECT_URLS=https://erp.boomeroff.com/**,https://open.boomeroff.top/**
PROXY_DOMAIN=data.boomeroff.top
SUPABASE_REF=949a57d2854b7fcadc0d621cb7fffa167506d581

KONG_HTTP_PORT=8100
KONG_HTTPS_PORT=8543
POSTGRES_PORT=55432
POOLER_PROXY_PORT_TRANSACTION=56543
BOOMER_POSTGRES_DATA=/srv/boomer-data/postgres

POSTGRES_PASSWORD=$postgres_password
DASHBOARD_USERNAME=boomer-admin
DASHBOARD_PASSWORD=$dashboard_password
JWT_SECRET=$jwt_secret
ANON_KEY=$anon_key
SERVICE_ROLE_KEY=$service_role_key
SECRET_KEY_BASE=$secret_key_base
REALTIME_DB_ENC_KEY=$realtime_db_enc_key
VAULT_ENC_KEY=$vault_enc_key
PG_META_CRYPTO_KEY=$pg_meta_crypto_key
LOGFLARE_PUBLIC_ACCESS_TOKEN=$logflare_public
LOGFLARE_PRIVATE_ACCESS_TOKEN=$logflare_private
S3_PROTOCOL_ACCESS_KEY_ID=$s3_protocol_id
S3_PROTOCOL_ACCESS_KEY_SECRET=$s3_protocol_secret
POOLER_TENANT_ID=boomer

STORAGE_BACKEND=s3
GLOBAL_S3_BUCKET=$COS_BUCKET
GLOBAL_S3_ENDPOINT=https://cos.${COS_REGION:-ap-shanghai}.myqcloud.com
GLOBAL_S3_PROTOCOL=https
GLOBAL_S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=$TENCENTCLOUD_SECRETID
AWS_SECRET_ACCESS_KEY=$TENCENTCLOUD_SECRETKEY
REGION=${COS_REGION:-ap-shanghai}

DISABLE_SIGNUP=true
ENABLE_EMAIL_SIGNUP=false
ENABLE_ANONYMOUS_USERS=false
EOF

install -m 600 "$temp" "$target"
echo "Created $target with mode 0600."
