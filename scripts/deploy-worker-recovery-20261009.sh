#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) == 0 ]] || { echo "Run with sudo" >&2; exit 1; }
payload="${1:?Expected uploaded payload directory}"
backup=/var/backups/boomer-worker-recovery-20261009
runner=/opt/boomer-erp-ops/recovery-20261009
importer=/opt/boomer-data-platform/migration/migrate-boomer-open.mjs
dropin=/etc/systemd/system/boomer-shortage-refunds.service.d/boomer-runner.conf
[[ ! -e "$backup" && ! -e "$dropin" ]] || { echo "Existing recovery: inspect before retry" >&2; exit 1; }
[[ $(sha256sum "$importer" | cut -d' ' -f1) == cef5566ee07bd64d11cb8d96c2f4295f9933c1f8584fb014ba3068e02f6c034a ]] || { echo "Importer changed; coordinate before deployment" >&2; exit 1; }
systemctl is-active --quiet boomer-open-sync.timer
systemctl is-active --quiet boomer-shortage-refunds.timer
[[ $(systemctl show boomer-open-sync.service -p ActiveState --value) != activating ]]
[[ $(systemctl show boomer-shortage-refunds.service -p ActiveState --value) != activating ]]
/usr/bin/node --env-file=/var/www/boomer-erp/current/.env -e 'if ((process.env.SHORTAGE_REFUND_WORKER_ENABLED||"").trim()==="true") { console.error("Refunds enabled: refuse diagnostic execution"); process.exit(1); }'
trap 'systemctl start boomer-open-sync.timer boomer-shortage-refunds.timer' EXIT
systemctl stop boomer-open-sync.timer boomer-shortage-refunds.timer
[[ $(systemctl show boomer-open-sync.service -p ActiveState --value) != activating ]]
[[ $(systemctl show boomer-shortage-refunds.service -p ActiveState --value) != activating ]]
install -d -m 0700 "$backup"
cp -p "$importer" "$backup/migrate-boomer-open.mjs"
cp -p "$(dirname "$importer")/boomer-open-transform.mjs" "$backup/boomer-open-transform.mjs"
systemctl cat boomer-shortage-refunds.service > "$backup/refund-unit.before.txt"
readlink -f /var/www/boomer-erp/current > "$backup/erp-release.before.txt"
sha256sum /etc/boomer-erp/workers.env /var/www/boomer-erp/shared/.env > "$backup/environment.before.sha256"

rollback() {
  local result=$?
  trap - ERR
  cp -p "$backup/migrate-boomer-open.mjs" "$importer"
  cp -p "$backup/boomer-open-transform.mjs" "$(dirname "$importer")/boomer-open-transform.mjs"
  rm -f "$dropin"
  systemctl daemon-reload
  systemctl start boomer-open-sync.timer boomer-shortage-refunds.timer
  echo "Worker deployment rolled back; ERP was not restarted" >&2
  exit "$result"
}
trap rollback ERR
docker exec supabase-db pg_dump -U postgres -d postgres -Fc -t 'public.store_development_*' > "$backup/store-development.before.dump"
test -s "$backup/store-development.before.dump"
docker exec -i supabase-db pg_restore --list < "$backup/store-development.before.dump" > "$backup/dump-manifest.txt"
install -d -m 0755 "$runner" "$(dirname "$dropin")"
install -m 0644 "$payload/run-shortage-refunds.mjs" "$runner/run-shortage-refunds.mjs"
install -m 0644 "$payload/migrate-boomer-open.mjs" "$importer.next"
chown --reference="$importer" "$importer.next"
mv "$importer.next" "$importer"
install -m 0644 "$payload/boomer-open-transform.mjs" "$(dirname "$importer")/boomer-open-transform.mjs.next"
chown --reference="$(dirname "$importer")/boomer-open-transform.mjs" "$(dirname "$importer")/boomer-open-transform.mjs.next"
mv "$(dirname "$importer")/boomer-open-transform.mjs.next" "$(dirname "$importer")/boomer-open-transform.mjs"
install -m 0644 "$payload/shortage-refund-runner-20261009.conf" "$dropin"
systemctl daemon-reload
systemctl start boomer-shortage-refunds.service
systemctl start boomer-open-sync.service
sha256sum --check "$backup/environment.before.sha256"
[[ $(readlink -f /var/www/boomer-erp/current) == $(<"$backup/erp-release.before.txt") ]]
systemctl start boomer-open-sync.timer boomer-shortage-refunds.timer
trap - ERR EXIT
echo "Worker recovery applied; ERP release/environment unchanged; backup=$backup"
