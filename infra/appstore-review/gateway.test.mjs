import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReviewGateway } from './gateway.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, options = {}) {
  const calls = [];
  const upstream = name => http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ name, path: req.url, token: req.headers['x-device-token'], body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name, body }));
  });
  const prod = upstream('production');
  const review = upstream('demo');
  t.after(() => { prod.closeAllConnections(); prod.close(); review.closeAllConnections(); review.close(); });
  const productionOrigin = await listen(prod);
  const reviewOrigin = await listen(review);
  const gateway = createReviewGateway({ productionOrigin, reviewOrigin,
    reviewEmail: 'app-review@demo.boomeroff.com', ...options });
  const url = await listen(gateway);
  t.after(() => { gateway.closeAllConnections(); gateway.close(); prod.close(); review.close(); });
  return { url, calls, review };
}

test('normal bootstrap is forwarded unchanged to production', async t => {
  const { url, calls } = await fixture(t);
  const body = JSON.stringify({ email: 'staff@example.com', password: 'private' });
  assert.equal((await fetch(url + '/api/public/handheld/auth/bootstrap', { method: 'POST', body })).status, 200);
  assert.deepEqual(calls.map(x => [x.name, x.body]), [['production', body]]);
});

test('only the exact configured demo email selects demo bootstrap', async t => {
  const { url, calls } = await fixture(t);
  for (const email of [' APP-REVIEW@DEMO.BOOMEROFF.COM ', 'xapp-review@demo.boomeroff.com']) {
    await fetch(url + '/api/public/handheld/auth/bootstrap', { method: 'POST',
      body: JSON.stringify({ email, password: 'private' }) });
  }
  assert.deepEqual(calls.map(x => x.name), ['demo', 'production']);
});

test('review token routes handheld and POS requests only into demo', async t => {
  const { url, calls } = await fixture(t);
  for (const path of ['/api/public/handheld/products', '/api/public/pos/sales']) {
    await fetch(url + path, { method: 'POST', headers: { 'X-Device-Token': 'rvw_token' }, body: '{"n":1}' });
  }
  assert.deepEqual(calls.map(x => x.name), ['demo', 'demo']);
  assert.equal(calls[0].token, 'rvw_token');
});

test('ordinary token and unrelated URL cannot select demo', async t => {
  const { url, calls } = await fixture(t);
  await fetch(url + '/api/public/handheld/products', { headers: { 'X-Device-Token': 'normal' } });
  await fetch(url + '/pos', { headers: { 'X-Device-Token': 'rvw_token' } });
  assert.deepEqual(calls.map(x => x.name), ['production', 'production']);
});

test('malformed or oversized bootstrap never reaches an upstream', async t => {
  const { url, calls } = await fixture(t, { bootstrapLimit: 128 });
  assert.equal((await fetch(url + '/api/public/handheld/auth/bootstrap', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await fetch(url + '/api/public/handheld/auth/bootstrap', { method: 'POST', body: 'a'.repeat(129) })).status, 413);
  assert.equal(calls.length, 0);
});

test('demo outage does not fall back to production', async t => {
  const { url, calls, review } = await fixture(t);
  await new Promise(resolve => review.close(resolve));
  const res = await fetch(url + '/api/public/handheld/products', { headers: { 'X-Device-Token': 'rvw_token' } });
  assert.equal(res.status, 502);
  assert.equal(calls.length, 0);
});

test('gateway rejects non-loopback origins', () => {
  assert.throws(() => createReviewGateway({ productionOrigin: 'https://example.com',
    reviewOrigin: 'http://127.0.0.1:3008', reviewEmail: 'a@b.com' }), /loopback/);
});

test('launcher listens even when imported by a process manager wrapper', async t => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import('./infra/appstore-review/start-gateway.mjs')"],
    { env: { ...process.env, PORT: '0', ERP_PRODUCTION_ORIGIN: 'http://127.0.0.1:39101',
      ERP_REVIEW_ORIGIN: 'http://127.0.0.1:39102', ERP_REVIEW_EMAIL: 'review@demo.example.com' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Gateway never listened')), 5000);
    child.stdout.once('data', value => { clearTimeout(timeout); resolve(JSON.parse(value.toString()).port); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Gateway launcher exited before listening')); });
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/public/handheld/products`)).status, 502);
});
