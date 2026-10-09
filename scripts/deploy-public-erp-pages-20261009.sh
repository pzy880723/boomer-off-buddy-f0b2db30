#!/usr/bin/env bash
set -euo pipefail
payload="${1:?Supply the uploaded payload directory}"
config=/etc/nginx/sites-enabled/erp.boomeroff.com
snippet=/etc/nginx/snippets/erp-public-pages-20261009.conf
backup=/var/backups/boomer-erp-public-20261009-v3
pages=/var/www/boomer-erp-public/appstore-20261009
[[ $(id -u) == 0 && ! -e "$backup" && ! -e "$snippet" && ! -e "$pages" ]] || exit 1
[[ $(sha256sum "$config" | cut -d' ' -f1) == 19adedb6c66d78ba560d1413d8635fa5b99354f19a6966d0c27dd982f0e833dd ]] || { echo 'Nginx changed; inspect before retry' >&2; exit 1; }
if [[ -f /var/lock/boomer-erp-release.lock ]]; then
  exec 9</var/lock/boomer-erp-release.lock
else
  exec 9>/var/lock/boomer-erp-release.lock
fi
flock -n 9
process() { runuser -u ubuntu -- pm2 jlist | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{const p=JSON.parse(s).find(p=>p.name==="boomer-off-buddy"); if(!p||p.pm2_env.status!=="online")process.exit(1); console.log(p.pid);});'; }
install -d -m 0700 "$backup"
cp -p "$config" "$backup/nginx.before.conf"
readlink -f /var/www/boomer-erp/current > "$backup/release.before.txt"
process > "$backup/process.before.txt"
sha256sum /etc/boomer-erp/workers.env /var/www/boomer-erp/shared/.env > "$backup/environment.before.sha256"
rollback() {
  result=$?
  trap - ERR
  cp -p "$backup/nginx.before.conf" "$config"
  nginx -t && systemctl reload nginx
  echo "Public pages rolled back; ERP application was not restarted" >&2
  exit "$result"
}
trap rollback ERR
install -d -m 0755 "$pages"
install -m 0644 "$payload/support.html" "$pages/support.html"
install -m 0644 "$payload/privacy.html" "$pages/privacy.html"
install -m 0644 "$payload/public-pages.conf" "$snippet"
node --input-type=module - "$config" "$snippet" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [path, snippet] = process.argv.slice(2);
const before = readFileSync(path, 'utf8');
const marker = '    include /etc/nginx/snippets/go-sync-internal-only.conf;';
if (before.split(marker).length !== 2) throw new Error('Expected one ERP server marker');
writeFileSync(path, before.replace(marker, `${marker}\n    include ${snippet};`));
JS
nginx -t
systemctl reload nginx
for route in support privacy; do
  curl -fsS --retry 3 --retry-all-errors --retry-delay 1 --max-time 15 "https://erp.boomeroff.com/$route" -o "$backup/$route.after.html"
  cmp "$pages/$route.html" "$backup/$route.after.html"
done
curl -fsS --max-time 15 https://erp.boomeroff.com/api/public/handheld/openapi.json -o /dev/null
sha256sum --check "$backup/environment.before.sha256"
[[ $(readlink -f /var/www/boomer-erp/current) == $(<"$backup/release.before.txt") ]]
[[ $(process) == $(<"$backup/process.before.txt") ]]
trap - ERR
echo "Support and privacy draft published; ERP PID, release and environments unchanged; backup=$backup"
