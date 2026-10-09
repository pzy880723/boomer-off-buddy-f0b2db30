import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const root = '/opt/boomer-appstore-review';
const env = Object.fromEntries(readFileSync(`${root}/.env`, 'utf8').split('\n').filter(x => x.includes('='))
  .map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; }));
const account = JSON.parse(readFileSync(`${root}/account.json`, 'utf8'));
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SERVICE_ROLE_KEY}` };
const update = await fetch(`http://127.0.0.1:3810/admin/users/${account.id}`, { method: 'PUT', headers,
  body: JSON.stringify({ user_metadata: { name: '演示总部账号' } }) });
if (!update.ok) throw new Error(`Demo profile update failed: HTTP ${update.status}`);
const email = 'app-demo-staff@demo.boomeroff.com';
const password = randomBytes(20).toString('base64url');
const response = await fetch('http://127.0.0.1:3810/admin/users', { method: 'POST', headers,
  body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name: '演示店员' } }) });
const data = await response.json();
if (!response.ok || !data.id) throw new Error(`Demo staff creation failed: HTTP ${response.status}`);
writeFileSync(`${root}/staff-account.json`, JSON.stringify({ id: data.id, email, password }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ created: true, id: data.id, environment: 'isolated-demo' }));
