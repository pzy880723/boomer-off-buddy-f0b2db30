import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readlinkSync, renameSync, symlinkSync, existsSync, unlinkSync, accessSync, constants, openSync, closeSync } from 'node:fs';

const base = '/var/www/boomer-erp';
const previous = process.env.SUPPORT_PREVIOUS_DIR;
const release = process.env.SUPPORT_RELEASE_DIR;
assert.match(previous ?? '', /^\/var\/www\/boomer-erp\/releases\/[a-z0-9-]+$/);
assert.match(release ?? '', /^\/var\/www\/boomer-erp\/releases\/support-[a-f0-9]{7,40}-[0-9]{8}$/);
assert.notEqual(release, previous);
const candidate = 'boomer-support-candidate';
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
  const temp = `${base}/.current-support`;
  if (existsSync(temp)) unlinkSync(temp);
  symlinkSync(dir, temp); renameSync(temp, `${base}/current`);
}
async function verify(origin) {
  for (const path of ['/pos', '/customer-service', '/api/public/handheld/openapi.json']) {
    assert.equal((await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(20000) })).status, 200, path);
  }
  const conv = '00000000-0000-4000-8000-000000000001';
  for (const [path, method] of [
    ['/api/public/handheld/support/conversations', 'GET'],
    [`/api/public/handheld/support/conversations/${conv}/assignment`, 'POST'],
    ['/api/public/storefront/support/conversations', 'GET'],
  ]) {
    const result = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(15000),
      ...(method === 'POST' ? { body: '{}', headers: { 'Content-Type': 'application/json' } } : {}) });
    assert.equal(result.status, 401, `Anonymous access must be rejected: ${path}`);
    assert.ok(result.headers.get('content-type')?.includes('application/json'));
  }
  assert.equal((await fetch(`${origin}/api/public/handheld/ai/generate-summary`, {
    method: 'OPTIONS', signal: AbortSignal.timeout(15000),
  })).status, 204);
  console.log(JSON.stringify({ origin, pageRoutes: 200, anonymousSupportAccess: 401, existingSummaryRoute: 204 }));
}
async function waitReady(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/public/handheld/openapi.json`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw Error('server_not_ready');
}
let switched = false;
let saveDir;
let candidateCreated = false;
const lock = `${base}/.support-release.lock`;
const lockFd = openSync(lock, 'wx');
function ownsProduction(allowMissing = false) {
  const current = readlinkSync(`${base}/current`);
  const process = JSON.parse(pm('jlist')).find(p => p.name === 'boomer-off-buddy');
  return (current === previous || current === release) &&
    (process?.pm2_env.pm_cwd === release || (allowMissing && !process));
}
try {
  assert.ok(!JSON.parse(pm('jlist')).some(p => p.name === candidate));
  assert.equal(execFileSync('ss', ['-Hlt', 'sport = :3006'], { encoding: 'utf8' }).trim(), '');
  candidateCreated = true;
  start(release, candidate, 3006);
  await waitReady(3006); await verify('http://127.0.0.1:3006');
  assert.equal(readlinkSync(`${base}/current`), previous, 'Another deployment changed current');
  switched = true;
  pm('delete', 'boomer-off-buddy'); start(release, 'boomer-off-buddy', 3005);
  await waitReady(3005); await verify('http://127.0.0.1:3005'); await verify('https://erp.boomeroff.com');
  assert.equal(readlinkSync(`${base}/current`), previous, 'Another deployment changed current');
  assert.ok(ownsProduction(), 'Another deployment changed production process');
  pointTo(release);
  saveDir = release;
  console.log(JSON.stringify({ release, previous, status: 'deployed' }));
} catch (error) {
  console.error('Support release failed:', error.message);
  if (switched && ownsProduction(true)) {
    try { pm('delete', 'boomer-off-buddy'); } catch {}
    start(previous, 'boomer-off-buddy', 3005); pointTo(previous);
    saveDir = previous;
    console.error('Rolled back to previous release');
  }
  throw error;
} finally {
  try {
    if (candidateCreated) {
      const process = JSON.parse(pm('jlist')).find(p => p.name === candidate);
      if (process?.pm2_env.pm_cwd === release) { try { pm('delete', candidate); } catch {} }
    }
    if (saveDir && readlinkSync(`${base}/current`) === saveDir &&
        JSON.parse(pm('jlist')).find(p => p.name === 'boomer-off-buddy')?.pm2_env.pm_cwd === saveDir) pm('save');
  } finally {
    closeSync(lockFd); unlinkSync(lock);
  }
}
