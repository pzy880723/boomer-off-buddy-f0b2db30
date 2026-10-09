import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = '/opt/boomer-appstore-review';
const results = JSON.parse(readFileSync(`${root}/verification-results.json`, 'utf8'));
assert.ok(results.length >= 23 && results.every(result => [200, 401, 403, 409].includes(result.status)));
const config = '/etc/nginx/sites-enabled/erp.boomeroff.com';
const before = readFileSync(config, 'utf8');
const anchor = '    include /etc/nginx/snippets/boomer-review-data.conf;';
const backup = `${root}/nginx.before-review-gateway.conf`;
assert.equal(before.split(anchor).length, 2);
assert.ok(!before.includes('boomer-review-gateway.conf') && !existsSync(backup));
const printRoute = /(location = \/api\/public\/handheld\/print\/store-qr \{[\s\S]*?proxy_pass )http:\/\/127\.0\.0\.1:3005;/;
assert.ok(printRoute.test(before));
const routes = ['/api/public/handheld/', '/api/public/pos/'].map(path => `
    location ${path} {
        proxy_pass http://127.0.0.1:3007;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300;
    }
`).join('');
const next = before.replace(anchor, `${anchor}\n    include /etc/nginx/snippets/boomer-review-gateway.conf;`)
  .replace(printRoute, '$1http://127.0.0.1:3007;');
copyFileSync(config, backup);
writeFileSync('/etc/nginx/snippets/boomer-review-gateway.conf', routes, { mode: 0o644, flag: 'wx' });
writeFileSync(config, next);
try {
  execFileSync('nginx', ['-t'], { stdio: 'inherit' });
  execFileSync('systemctl', ['reload', 'nginx']);
} catch (error) {
  writeFileSync(config, before);
  execFileSync('nginx', ['-t']);
  execFileSync('systemctl', ['reload', 'nginx']);
  throw error;
}
console.log('Activated independently authenticated demo routing for handheld and POS APIs.');
