import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readlinkSync, renameSync, symlinkSync, existsSync, unlinkSync, accessSync, constants } from 'node:fs';

const base = '/var/www/boomer-erp';
const previous = process.env.ASSET_PREVIOUS_DIR;
assert.match(previous ?? '', /^\/var\/www\/boomer-erp\/releases\/[a-z0-9-]+$/);
const release = process.env.ASSET_RELEASE_DIR;
assert.match(release ?? '', /^\/var\/www\/boomer-erp\/releases\/member-assets-[a-f0-9]{7,40}-20261005$/);
assert.notEqual(release, previous);
const candidate = 'boomer-member-assets-candidate';
const pm = (...args) => execFileSync('pm2', args, { encoding: 'utf8' });
assert.equal(readlinkSync(`${base}/current`), previous);
accessSync(base, constants.W_OK);
const running = JSON.parse(pm('jlist')).find(p => p.name === 'boomer-off-buddy');
assert.equal(running?.pm2_env.status, 'online');
const flags = {};
for (const key of ['HANDHELD_RELEASE_WORKER_ENABLED', 'HANDHELD_ITEM_SYNC_WORKER_ENABLED',
  'HANDHELD_LISTING_IMAGE_WORKER_ENABLED', 'YOUZAN_STOCK_WORKER_ENABLED', 'YOUZAN_IMAGE_REFRESH_WORKER_ENABLED']) {
  const value = running.pm2_env[key] ?? running.pm2_env.env?.[key];
  if (value !== undefined) flags[key] = value;
}
function start(dir, name, port) {
  execFileSync('pm2', ['start', `${dir}/scripts/run-tencent-erp.sh`, '--name', name,
    '--cwd', dir, '--interpreter', 'bash', '--time'], {
    env: { ...process.env, ...flags, APP_DIR: dir, ERP_PORT: String(port) }, stdio: 'pipe',
  });
}
function pointTo(dir) {
  const temp = `${base}/.current-member-assets`;
  if (existsSync(temp)) unlinkSync(temp);
  symlinkSync(dir, temp);
  renameSync(temp, `${base}/current`);
}
async function verify(origin) {
  const endpoint = `${origin}/api/public/hooks/youzan-message`;
  const post = (body, sign) => fetch(endpoint, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', ...(sign === undefined ? {} : { 'Event-Sign': sign }) },
    signal: AbortSignal.timeout(15000) });
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('[]')).status, 400);
  const invalidEvent = JSON.stringify({ type: 'POINTS', msg: encodeURIComponent('{}') });
  assert.equal((await post(invalidEvent, '0'.repeat(32))).status, 401);
  const id = process.env.YOUZAN_CLIENT_ID, secret = process.env.YOUZAN_CLIENT_SECRET;
  assert.ok(id && secret);
  const sign = createHash('md5').update(`${id}${invalidEvent}${secret}`).digest('hex');
  // Correct authentication, deliberately missing business identity: no database writes.
  assert.equal((await post(invalidEvent, sign)).status, 422);
  assert.equal((await post(`${invalidEvent} `, sign)).status, 401);
  for (const path of ['/pos', '/api/public/handheld/openapi.json']) {
    assert.equal((await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(20000) })).status, 200, path);
  }
  assert.equal((await fetch(`${origin}/api/public/handheld/ai/generate-summary`, {
    method: 'OPTIONS', signal: AbortSignal.timeout(15000),
  })).status, 204);
  console.log(JSON.stringify({ origin, malformed: 400, invalidSignature: 401, validSignatureInvalidEvent: 422,
    changedBody: 401, existingRoutes: 200, inboxWrites: 0 }));
}
async function waitReady(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/public/handheld/openapi.json`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw Error('server_not_ready');
}
let switched = false;
try {
  assert.ok(!JSON.parse(pm('jlist')).some(p => p.name === candidate));
  assert.equal(execFileSync('ss', ['-Hlt', 'sport = :3006'], { encoding: 'utf8' }).trim(), '');
  start(release, candidate, 3006);
  await waitReady(3006);
  await verify('http://127.0.0.1:3006');
  assert.equal(readlinkSync(`${base}/current`), previous, 'Another deployment changed current');
  switched = true;
  pm('delete', 'boomer-off-buddy');
  start(release, 'boomer-off-buddy', 3005);
  await waitReady(3005);
  await verify('http://127.0.0.1:3005');
  await verify('https://erp.boomeroff.com');
  pointTo(release);
  console.log(JSON.stringify({ release, previous, status: 'deployed', independentRedemptionEnabled: false }));
} catch (error) {
  console.error('Asset release verification failed:', error.message);
  if (switched) {
    try { pm('delete', 'boomer-off-buddy'); } catch {}
    start(previous, 'boomer-off-buddy', 3005);
    pointTo(previous);
    console.error('Rolled back to previous release');
  }
  throw error;
} finally {
  try { pm('delete', candidate); } catch {}
  if (switched) pm('save');
}
