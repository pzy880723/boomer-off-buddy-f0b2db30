import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChannelSync } from './run-channel-sync.mjs';
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
