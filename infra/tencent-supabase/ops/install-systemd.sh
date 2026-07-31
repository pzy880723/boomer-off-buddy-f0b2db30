#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
install_dir="${BOOMER_OPS_ROOT:-/opt/boomer-data-platform/ops}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

install -d -m 755 "$install_dir"
if [[ "$source_dir" != "$install_dir" ]]; then
  install -m 750 "${source_dir}/backup.sh" "${install_dir}/backup.sh"
  install -m 750 "${source_dir}/healthcheck.sh" "${install_dir}/healthcheck.sh"
  install -m 750 \
    "${source_dir}/sync-boomer-open.sh" \
    "${install_dir}/sync-boomer-open.sh"
else
  chmod 750 \
    "${install_dir}/backup.sh" \
    "${install_dir}/healthcheck.sh" \
    "${install_dir}/sync-boomer-open.sh"
fi
install -m 644 "${source_dir}/systemd/boomer-data-backup.service" \
  /etc/systemd/system/boomer-data-backup.service
install -m 644 "${source_dir}/systemd/boomer-data-backup.timer" \
  /etc/systemd/system/boomer-data-backup.timer
install -m 644 "${source_dir}/systemd/boomer-data-health.service" \
  /etc/systemd/system/boomer-data-health.service
install -m 644 "${source_dir}/systemd/boomer-data-health.timer" \
  /etc/systemd/system/boomer-data-health.timer
install -m 644 "${source_dir}/systemd/boomer-open-sync.service" \
  /etc/systemd/system/boomer-open-sync.service
install -m 644 "${source_dir}/systemd/boomer-open-sync.timer" \
  /etc/systemd/system/boomer-open-sync.timer

systemctl daemon-reload
systemctl enable --now \
  boomer-data-backup.timer \
  boomer-data-health.timer \
  boomer-open-sync.timer

"${install_dir}/healthcheck.sh"
systemctl list-timers \
  boomer-data-backup.timer \
  boomer-data-health.timer \
  boomer-open-sync.timer \
  --no-pager
