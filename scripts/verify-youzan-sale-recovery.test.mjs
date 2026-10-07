import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyRecovery, INCIDENT } from './verify-youzan-sale-recovery.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const data = {
      inv_stocks: [{ qty: 0, location_id: INCIDENT.location }],
      inv_skus: [{ is_display: false, sales_state: 'sold_syncing', inventory_version: 1 }],
      commerce_listings: [{ status: 'sold' }],
      inventory_sale_events: [{ status: 'processed', source_order_id: INCIDENT.legacyKey }],
      inv_stock_movements: [{ delta: -1, balance_after: 0 }],
      ...overrides,
    };
    if (path.startsWith('/rest/v1/')) return Response.json(data[path.split('/').at(-1)]);
    if (path.startsWith('/api/public/hooks/')) return Response.json({ code: 'unauthorized' }, { status: 401 });
    if (path.endsWith(INCIDENT.listing)) return Response.json({ ok: false }, { status: 404 });
    return Response.json({ ok: true, data: [] });
  };
  return { request, calls };
}
const config = { base: 'http://127.0.0.1:3006', database: 'https://test.invalid', token: 'test-service-key' };
test('read-only recovery check verifies stock, storefront and single debit without sending worker credentials', async () => {
  const f = fixture();
  assert.equal((await verifyRecovery(config, f.request)).passed, true);
  for (const call of f.calls.filter(x => x.url.includes('/api/public/hooks/'))) {
    assert.equal(call.init.headers?.Authorization, undefined);
    assert.equal(call.init.body, '{}');
  }
  assert.ok(f.calls.filter(x => x.url.includes('/rest/v1/')).every(x => (x.init.method ?? 'GET') === 'GET'));
});
for (const [name, value] of Object.entries({
  inv_stocks: [{ qty: 1, location_id: INCIDENT.location }],
  inv_skus: [{ is_display: true, sales_state: 'active', inventory_version: 1 }],
  commerce_listings: [{ status: 'published' }],
  inventory_sale_events: [],
  inv_stock_movements: [{ delta: -1 }, { delta: -1 }],
})) {
  test(`rejects incomplete or duplicate recovery: ${name}`, async () => {
    await assert.rejects(verifyRecovery(config, fixture({ [name]: value }).request));
  });
}
test('rejects a different public origin before making requests', async () => {
  await assert.rejects(verifyRecovery({ ...config, base: 'https://other.invalid' }, () => { throw Error('must not run'); }));
});
