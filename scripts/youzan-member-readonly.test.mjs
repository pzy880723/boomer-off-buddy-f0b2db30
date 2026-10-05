import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadOnlyYouzan, resolveMappedMember, parsePoints } from './youzan-member-readonly.mjs';

test('points require a safe nonnegative value and an exact account version', () => {
  assert.deepEqual(parsePoints({ point: 0, points_account_version: '9007199254740999' }),
    { points: 0, accountVersion: '9007199254740999' });
  for (const data of [{ point: -1 }, { point: '2' }, { point: 1, points_account_version: 9007199254740992 },
    { point: 1, points_account_version: 'abc' }, { point: true }, null]) {
    assert.throws(() => parsePoints(data), /invalid_points_snapshot/);
  }
});
test('identity is scoped to the authorized chain and never matched by phone', () => {
  const shops = [{ kdt_id: 10, role: 'hq', status: 'active' },
    { kdt_id: 11, parent_kdt_id: 10, role: 'branch', status: 'active' }];
  const links = [{ customer_id: 'erp-a', kdt_id: 10, yz_id: 'yz-a' }];
  assert.deepEqual(resolveMappedMember(shops, links, 11, 'yz-a'),
    { customerId: 'erp-a', yzOpenId: 'yz-a', headquartersKdtId: 10 });
  assert.equal(resolveMappedMember(shops, links, 12, 'yz-a'), null);
  assert.equal(resolveMappedMember(shops, links, 11, 'unknown'), null);
  assert.equal(resolveMappedMember(shops, [...links, { customer_id: 'erp-b', kdt_id: 11, yz_id: 'yz-a' }], 11, 'yz-a'), null);
  assert.equal(resolveMappedMember(shops.map(x => ({ ...x, status: 'inactive' })), links, 11, 'yz-a'), null);
});
test('read client refuses all mutation methods before network I/O', async () => {
  let calls = 0;
  const read = createReadOnlyYouzan({ proxyUrl: 'https://proxy.test', proxyToken: 'private', accessToken: 'private',
    fetchImpl: async () => { calls++; throw Error('unexpected request'); } });
  await assert.rejects(read('youzan.crm.customer.points.operate.freeze', '4.0.0', {}), /read_method_not_allowed/);
  await assert.rejects(read('youzan.ump.voucher.query.detail', '1.0.1', {}), /read_method_not_allowed/);
  assert.equal(calls, 0);
});
test('read calls use the fixed proxy and preserve successful data', async () => {
  const read = createReadOnlyYouzan({ proxyUrl: 'https://proxy.test', proxyToken: 'proxy-secret', accessToken: 'api-secret',
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://proxy.test');
      assert.equal(request.headers.Authorization, 'Bearer proxy-secret');
      const envelope = JSON.parse(request.body);
      assert.equal(JSON.parse(envelope.body).user.account_id, 'mapped-id');
      return Response.json({ status: 200, body: JSON.stringify({ code: 200, success: true, data: { point: 8 } }) });
    } });
  assert.deepEqual(await read('youzan.crm.customer.points.get', '1.0.0', { user: { account_id: 'mapped-id', account_type: 5 } }), { point: 8 });
});
test('failure messages cannot leak token or customer data; missing proxy never goes direct', async () => {
  assert.throws(() => createReadOnlyYouzan({ accessToken: 'private' }), /fixed_proxy_not_configured/);
  const read = createReadOnlyYouzan({ proxyUrl: 'https://proxy.test', proxyToken: 'private', accessToken: 'private',
    fetchImpl: async () => Response.json({ status: 200, body: JSON.stringify({ code: 4204, success: false, message: 'private customer info' }) }) });
  await assert.rejects(read('youzan.crm.customer.points.get', '1.0.0', {}), /^Error: youzan_read_rejected_4204$/);
});
