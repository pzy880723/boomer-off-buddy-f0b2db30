import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChannelSync } from './run-channel-sync.mjs';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('systemd entry through current symlink actually invokes both stock and delist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boomer-channel-symlink-'));
  try {
    const entry = join(dir, 'current.mjs');
    const preload = join(dir, 'fixture.mjs');
    symlinkSync(fileURLToPath(new URL('./run-channel-sync.mjs', import.meta.url)), entry);
    writeFileSync(preload, 'globalThis.fetch = async () => Response.json({ok:true,claimed:0,results:[]});');
    const r = spawnSync(process.execPath, ['--import', preload, entry], { encoding:'utf8', env:{...process.env,SUPABASE_SERVICE_ROLE_KEY:'fixture-key',ERP_PORT:'3005'} });
    assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.ok, true);
    assert.deepEqual(output.results.map(x => x.action), ['set_stock_zero','delist']);
    assert.ok(!r.stdout.includes('fixture-key'));
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
test('runner only requests bounded sale actions and checks every task result', async () => {
  const calls = [];
  const result = await runChannelSync({ token: 'fixture-key' }, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, claimed: 1, results: [{ ok: true, status: 'succeeded' }] });
  });
  assert.equal(result.ok,true);
  assert.deepEqual(calls.map(x => JSON.parse(x.init.body).action), ['set_stock_zero','delist']);
  assert.ok(calls.every(x => x.url.startsWith('http://127.0.0.1:3005/') && JSON.parse(x.init.body).lease_seconds === 300));
  assert.ok(!JSON.stringify(result).includes('fixture-key'));
});
test('failed tasks cannot pass just because HTTP is 200', async () => {
  const result = await runChannelSync({ token: 'key', action: 'delist' }, async () =>
    Response.json({ ok: true, claimed: 1, results: [{ ok: false, status: 'retry_wait' }] }));
  assert.equal(result.ok,false);
});
test('canary claims only one SKU and one action', async () => {
  const skuId = '4c50282c-e82a-41a3-ae3b-fe88a6fdea43';
  const result = await runChannelSync({ token: 'key', skuId, action: 'delist' }, async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body),{ action:'delist',limit:1,lease_seconds:300,sku_id:skuId });
    return Response.json({ ok: true, claimed: 1, results: [{ ok: true, status:'superseded' }] });
  });
  assert.equal(result.results[0].superseded,1);
});
test('missing credentials or a remote port is rejected without any request', async () => {
  const request = () => { throw Error('no network allowed'); };
  await assert.rejects(runChannelSync({ token:'' },request));
  await assert.rejects(runChannelSync({ token:'key',port:'443' },request));
});
