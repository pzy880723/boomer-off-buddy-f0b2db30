#!/usr/bin/env bash
set -euo pipefail

min_cpu=2
recommended_cpu=4
min_memory_bytes=$((4 * 1024 * 1024 * 1024))
# Cloud vendors sell an "8 GB" instance with roughly 7.5 GiB visible to Linux.
recommended_memory_bytes=$((7500 * 1024 * 1024))
min_free_bytes=$((40 * 1024 * 1024 * 1024))
recommended_free_bytes=$((80 * 1024 * 1024 * 1024))

cpu="$(nproc)"
memory_bytes="$(awk '/MemTotal/{print $2 * 1024}' /proc/meminfo)"
if [[ -d /srv/boomer-data ]]; then
  free_bytes="$(df -B1 --output=avail /srv/boomer-data | tail -n 1 | tr -d ' ')"
else
  free_bytes="$(df -B1 --output=avail / | tail -n 1 | tr -d ' ')"
fi

printf 'CPU cores: %s (minimum %s, recommended %s)\n' \
  "$cpu" "$min_cpu" "$recommended_cpu"
printf 'RAM bytes: %s (minimum %s, recommended %s)\n' \
  "$memory_bytes" "$min_memory_bytes" "$recommended_memory_bytes"
printf 'Free disk bytes: %s (minimum %s, recommended %s)\n' \
  "$free_bytes" "$min_free_bytes" "$recommended_free_bytes"

if (( cpu < min_cpu || memory_bytes < min_memory_bytes || free_bytes < min_free_bytes )); then
  echo "FAIL: host is below the minimum Supabase capacity." >&2
  exit 1
fi

if (( cpu < recommended_cpu || memory_bytes < recommended_memory_bytes || free_bytes < recommended_free_bytes )); then
  echo "FAIL: host passes the upstream minimum but is below BOOMER's production requirement." >&2
  exit 1
fi

echo "PASS: host meets the recommended production capacity."
