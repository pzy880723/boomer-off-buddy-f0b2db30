import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = '/var/www/boomer-erp/review-41182c7b';
const file = `${root}/.env`;
const before = readFileSync(file, 'utf8');
if (!before.includes('BOOMER_REVIEW_ISOLATED=true')) throw new Error('Not an isolated review environment');
copyFileSync(file, '/opt/boomer-appstore-review/backend.before-media.env');
const next = before.replace(/^PUBLIC_APP_ORIGIN=.*$/m, 'PUBLIC_APP_ORIGIN=https://erp.boomeroff.com/review-runtime');
if (next === before) throw new Error('Expected review image origin setting');
const nginxFile = '/etc/nginx/snippets/boomer-review-data.conf';
const previousRoutes = readFileSync(nginxFile, 'utf8');
copyFileSync(nginxFile, '/opt/boomer-appstore-review/nginx.before-review-media.conf');
writeFileSync(nginxFile, readFileSync('/tmp/review-data.conf'));
try {
  execFileSync('nginx', ['-t'], { stdio: 'inherit' });
  execFileSync('systemctl', ['reload', 'nginx']);
  writeFileSync(file, next, { mode: 0o600 });
} catch (error) {
  writeFileSync(nginxFile, previousRoutes);
  execFileSync('nginx', ['-t']);
  execFileSync('systemctl', ['reload', 'nginx']);
  throw error;
}
console.log('Isolated image origin configured; restart only boomer-review-api.');
