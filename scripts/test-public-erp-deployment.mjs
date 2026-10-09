import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../deployments/appstore-public-20261009/public-pages.conf', import.meta.url), 'utf8');
assert.equal((config.match(/location = /g) ?? []).length, 2);
for (const route of ['support', 'privacy']) {
  assert.ok(config.includes(`location = /${route} {`));
  assert.ok(config.includes(`/var/www/boomer-erp-public/appstore-20261009/${route}.html;`));
}
assert.equal((config.match(/limit_except GET/g) ?? []).length, 2);
assert.ok(!config.includes('proxy_pass'));
assert.ok(!config.includes('/api/'));
const deploy = readFileSync(new URL('./deploy-public-erp-pages-20261009.sh', import.meta.url), 'utf8');
for (const guard of ['19adedb6c66d78ba560d1413d8635fa5b99354f19a6966d0c27dd982f0e833dd', 'nginx -t', 'rollback', 'environment.before.sha256', 'release.before.txt', 'process.before.txt']) {
  assert.ok(deploy.includes(guard), `Missing deployment guard: ${guard}`);
}
assert.ok(!/pm2 (restart|delete|start)|systemctl restart/.test(deploy));
console.log('PASS: exact public routes, read-only methods, rollback and ERP preservation guards');
