import { randomBytes, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || '/opt/boomer-appstore-review');
mkdirSync(root, { recursive: true, mode: 0o700 });
const secret = randomBytes(48).toString('hex');
const password = randomBytes(32).toString('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(role) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'supabase', role, iat: now, exp: now + 31536000 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
writeFileSync(resolve(root, '.env'), [
  `POSTGRES_PASSWORD=${password}`, `JWT_SECRET=${secret}`,
  `ANON_KEY=${jwt('anon')}`, `SERVICE_ROLE_KEY=${jwt('service_role')}`,
  'REVIEW_EMAIL=app-review@demo.boomeroff.com',
  `REVIEW_PASSWORD=${randomBytes(20).toString('base64url')}`,
  '',
].join('\n'), { mode: 0o600, flag: 'wx' });
console.log('Independent review credentials created; existing files are never overwritten.');
