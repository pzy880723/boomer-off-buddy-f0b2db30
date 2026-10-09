import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || '/opt/boomer-appstore-review');
const env = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split('\n')
  .filter(line => line.includes('=')).map(line => { const n = line.indexOf('='); return [line.slice(0, n), line.slice(n + 1)]; }));
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SERVICE_ROLE_KEY}` };
const response = await fetch('http://127.0.0.1:3810/admin/users', { method: 'POST', headers,
  body: JSON.stringify({ email: env.REVIEW_EMAIL, password: env.REVIEW_PASSWORD, email_confirm: true,
    user_metadata: { display_name: '演示门店员工' } }) });
const data = await response.json();
if (!response.ok || !data.id) throw new Error(`Review account creation failed: HTTP ${response.status}`);
writeFileSync(resolve(root, 'account.json'), JSON.stringify({ id: data.id, email: env.REVIEW_EMAIL,
  password: env.REVIEW_PASSWORD, environment: 'isolated-demo' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const login = await fetch('http://127.0.0.1:3810/token?grant_type=password', { method: 'POST', headers,
  body: JSON.stringify({ email: env.REVIEW_EMAIL, password: env.REVIEW_PASSWORD }) });
const session = await login.json();
if (!login.ok || session.user?.id !== data.id || !session.access_token) throw new Error('Review login verification failed');
console.log(JSON.stringify({ created: true, password_login: true, id: data.id, environment: 'isolated-demo' }));
