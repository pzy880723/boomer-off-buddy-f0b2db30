import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const config = '/etc/nginx/sites-enabled/erp.boomeroff.com';
const marker = '    include /etc/nginx/snippets/erp-public-pages-20261009.conf;';
const addition = '    include /etc/nginx/snippets/boomer-review-data.conf;';
const before = readFileSync(config, 'utf8');
if (before.includes(addition)) throw new Error('Review data routes already installed');
if (before.split(marker).length !== 2) throw new Error('Unexpected ERP Nginx configuration');
const backup = '/opt/boomer-appstore-review/nginx.before-review-data.conf';
if (existsSync(backup)) throw new Error('Backup exists; inspect before repeating installation');
copyFileSync(config, backup);
writeFileSync('/etc/nginx/snippets/boomer-review-data.conf', readFileSync('/tmp/review-data.conf'), { flag: 'wx', mode: 0o644 });
writeFileSync(config, before.replace(marker, `${marker}\n${addition}`));
try {
  execFileSync('nginx', ['-t'], { stdio: 'inherit' });
  execFileSync('systemctl', ['reload', 'nginx']);
} catch (error) {
  writeFileSync(config, before);
  throw new Error('Review data routes not activated; original Nginx config restored');
}
console.log('Added isolated data routes; employee ERP upstream unchanged.');
