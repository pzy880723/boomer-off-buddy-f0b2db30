import assert from 'node:assert/strict';
import { test } from 'node:test';
const skuId = '18ace324-fbd1-4c8e-8dcd-12f01329a99e';
const audit = [{ sku: { id: skuId, barcode: 'B' }, master: { spu_id: 10, spu_code: 'BM1' },
  links: [{ shop_id: 'hq', yz_item_id: 10 }], branches: [{ kdt: 1 }] }];
const shops = [{ id: 'a', kdt_id: 1 }, { id: 'b', kdt_id: 2 }];

test('queries only explicit scope x active stores, missing product means absent only for exact API codes', async () => {
  const { auditBranchVisibility } = await import('./audit-youzan-branch-visibility.mjs');
  const calls = [];
  const result = await auditBranchVisibility({ audit, skuIds: [skuId], shops, hqId: 'hq', readDetail: async (kdt, code) => {
    calls.push([kdt, code]);
    if (kdt === 2) return { state: 'absent' };
    return { state: 'present', detail: { kdt_id: 1, channel: 1, item_code: 'BM1', item_id: 10,
      channel_item_id: 20, display: 1, sold_num: 0, item_barcode: 'B',
      skus: [{ sku_id: 30, channel_sku_id: 40, sku_barcode: 'B', price: 39900 }] } };
  } });
  assert.equal(result.ok, true); assert.deepEqual(calls, [[1, 'BM1'], [2, 'BM1']]);
  assert.equal(result.products[0].branches[1].state, 'absent');
});

test('scope caps and missing master identity fail before any API request', async () => {
  const { auditBranchVisibility } = await import('./audit-youzan-branch-visibility.mjs');
  let count = 0;
  for (const input of [{ skuIds: [] }, { skuIds: Array(14).fill(skuId) }, { skuIds: ['bad'] }, { audit: [] }]) {
    await assert.rejects(auditBranchVisibility({ audit, skuIds: [skuId], shops, hqId: 'hq', readDetail: async () => { count++; }, ...input }));
  }
  assert.equal(count, 0);
});

test('mismatch/errors remain unknown, never absent; visible other store fails exclusivity', async () => {
  const { auditBranchVisibility } = await import('./audit-youzan-branch-visibility.mjs');
  for (const readDetail of [async () => { throw Error('secret token must not escape'); },
    async () => ({ state: 'present', detail: { kdt_id: 999 } }),
  ]) {
    const result = await auditBranchVisibility({ audit, skuIds: [skuId], shops, hqId: 'hq', readDetail });
    assert.equal(result.ok, false);
    assert.equal(result.products[0].branches[0].state, 'error');
    assert.ok(!JSON.stringify(result).includes('secret token'));
  }
});

test('HTTP adapter permits only official read endpoint, redirection blocked and exact not-found codes', async () => {
  const { readBranchDetail } = await import('./audit-youzan-branch-visibility.mjs');
  const calls = [];
  const fetcher = (body, status = 200) => async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(body), { status });
  };
  assert.deepEqual(await readBranchDetail(fetcher({ code: 122001001, success: false }), 'dummy', 1, 'BM1'), { state: 'absent' });
  assert.match(calls[0].url, /^https:\/\/open\.youzanyun\.com\/api\/youzan\.item\.itemdetail\.get\/1\.0\.0\?/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { request: { kdt_id: 1, item_code: 'BM1', channel: 1 } });
  for (const body of [{ code: 500, message: '商品不存在' }, { success: false, message: 'expired token' }])
    await assert.rejects(readBranchDetail(fetcher(body), 'dummy', 1, 'BM1'));
  await assert.rejects(readBranchDetail(fetcher({ code: 122001001 }, 503), 'dummy', 1, 'BM1'));
});

test('explicit malformed channel stock cannot be silently omitted from evidence', async () => {
  const { normalizeVisibilityDetail } = await import('./audit-youzan-branch-visibility.mjs');
  const row = { kdt_id: 1, channel: 1, item_code: 'BM1', item_id: 10, channel_item_id: 20,
    display: 1, sold_num: 0, item_barcode: 'B', skus: [{ sku_id: 30, channel_sku_id: 40, price: 100, stock_num_str: 'NaN' }] };
  assert.throws(() => normalizeVisibilityDetail(row, 1, 'BM1'));
});
