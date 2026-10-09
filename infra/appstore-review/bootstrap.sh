#!/usr/bin/env bash
set -euo pipefail
root=/opt/boomer-appstore-review
source_init=/srv/boomer-data/supabase/runtime/volumes/db
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
[[ ! -e "$root/.env" ]] || { echo 'Review environment already exists; refusing to reset'; exit 1; }
[[ $(df --output=avail -B1 /opt | tail -1) -gt 5368709120 ]] || { echo 'Insufficient disk'; exit 1; }
[[ $(awk '/MemAvailable/ {print $2}' /proc/meminfo) -gt 2097152 ]] || { echo 'Insufficient available RAM'; exit 1; }
if ss -lnt | awk '{print $4}' | grep -Eq ':(3810|3811|3812)$'; then
  echo 'Review API port already occupied'; exit 1
fi
install -d -m 700 "$root" "$root/init" "$root/data"
install -m 600 /tmp/compose.yml "$root/compose.yml"
install -m 600 /tmp/generate-env.mjs /tmp/create-account.mjs "$root/"
install -m 644 /tmp/boomer-review-roles.sql "$root/init/roles.sql"
install -m 644 "$source_init/jwt.sql" "$root/init/jwt.sql"
node "$root/generate-env.mjs" "$root"
cd "$root"
docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3810/health >/dev/null; then
    echo 'Independent review Auth is healthy'; exit 0
  fi
  sleep 2
done
echo 'Review health check failed'; exit 1
