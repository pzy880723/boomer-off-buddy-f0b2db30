import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const script = new URL('./run-youzan-sync.mjs', import.meta.url);
const source = existsSync(script) ? readFileSync(script, 'utf8') : '';
const secret = 'local-only-service-role-test-key';
async function run({ env = { SUPABASE_SERVICE_ROLE_KEY: secret }, response = Response.json({ ok: true, order_windows: 4 }), error } = {}) {
  const calls = [], logs = [];
  const process = { env, exitCode: 0 };
  await vm.runInNewContext(`(async () => {${source}\n})()`, {
    process, AbortSignal, console: { log: value => logs.push(value), error: value => logs.push(value) },
    fetch: async (url, init) => { calls.push({ url, init }); if (error) throw error; return response; },
  });
  assert.ok(!JSON.stringify(logs).includes(secret), 'runner must not log credentials or raw failures');
  return { process, calls, logs };
}

for (const port of [undefined, '3006']) test(`runner posts fixed 3-day / 3-slice job to loopback ${port ?? '3005'} without redirects`, async () => {
  const result = await run({ env: { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: port } });
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.calls.length, 1);
  const { url, init } = result.calls[0];
  assert.equal(url, `http://127.0.0.1:${port ?? '3005'}/api/public/hooks/youzan-sync`);
  assert.equal(init.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(init.body), { days: 3, slices: 3 });
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
});

for (const env of [{}, { SUPABASE_PUBLISHABLE_KEY: secret }, { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: '443' }, { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: '3005/evil' }]) {
  test(`runner rejects missing secret or unsupported port (${Object.keys(env).join(',')}) before fetch`, async () => {
    const result = await run({ env });
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.calls.length, 0);
  });
}

for (const [label, response] of [
  ['HTTP failure', Response.json({ ok: true }, { status: 500 })],
  ['207 even with ok true', Response.json({ ok: true }, { status: 207 })],
  ['business failure', Response.json({ ok: false })],
  ['missing ok', Response.json({})],
  ['non-boolean ok', Response.json({ ok: 'true' })],
  ['invalid JSON', new Response('not JSON')],
]) test(`runner reports ${label} as failure`, async () => {
  const result = await run({ response });
  assert.equal(result.process.exitCode, 1);
});

test('runner sanitizes network/redirect errors, never logs credential-bearing exception', async () => {
  const result = await run({ error: new Error(`request Authorization: Bearer ${secret}`) });
  assert.equal(result.process.exitCode, 1);
});

test('runner logs only bounded summary, not server response payload', async () => {
  const result = await run({ response: Response.json({ ok: false, message: secret, order_slices: [{ error: secret }] }) });
  assert.equal(result.process.exitCode, 1);
});
