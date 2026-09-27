import assert from 'node:assert/strict';
import { test } from 'node:test';

const load = () => import('./verify-youzan-repair-audit.mjs');
const ids = ['18ace324-fbd1-4c8e-8dcd-12f01329a99e', 'fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3'];
function product(id, qty) {
  const index = ids.indexOf(id);
  const code = ['BM529821940370', 'BM645119936025'][index] ?? 'OTHER';
  const barcode = ['2006890664290', '2000128424847'][index] ?? '2000000000003';
  const price = [399, 299][index] ?? 100;
  const detail = { kdt_id: 212291308, channel: 1, item_code: code, item_id: 10 + index,
    channel_item_id: 100 + index, item_barcode: barcode, display: 1, sold_num: 0,
    skus: [{ sku_id: 20 + index, channel_sku_id: 200 + index, sku_code: code, sku_barcode: barcode, price: price * 100 }] };
  return { sku: { id, name: code, barcode, price_tier: price },
    master: { spu_id: 30 + index, spu_code: code, retail_price: price, skus: [{ sku_id: 40 + index, sku_code: code }] },
    hqDetail: { ...structuredClone(detail), kdt_id: 123, channel: 0 },
    branches: [{ name: 'Xintiandi', kdt: 212291308, erpQty: 1, detail,
      warehouse: [{ sku_code: code, stock_num: qty, freeze_num: 0 }] }] };
}
const fixture = () => ({ before: ids.map(id => product(id, 0)), after: ids.map(id => product(id, 1)) });

test('exact two authorized WMS changes pass despite row reordering and image edits', async () => {
  const { compareRepairAudits } = await load(); const { before, after } = fixture();
  after.reverse(); after[0].branches[0].detail.media = { images: ['new'] };
  const result = compareRepairAudits(before, after);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.expected_stock_changes.length, 2);
});

test('missing products, duplicate IDs, audit errors and incomplete fields fail closed', async () => {
  const { compareRepairAudits } = await load();
  for (const mutate of [
    a => a.pop(), a => a.push(a[0]), a => { a[0] = { id: ids[0], error: 'read failed' }; },
    a => { delete a[0].branches[0].warehouse[0].freeze_num; },
    a => { a[0].branches = []; }, a => { a[0].branches[0].detail.skus[0].price = null; },
  ]) { const { before, after } = fixture(); mutate(after); assert.equal(compareRepairAudits(before, after).ok, false); }
});

test('no stock change, double add, unrelated stock change, ERP/freeze/sold drift fail', async () => {
  const { compareRepairAudits } = await load();
  for (const mutate of [
    a => { a[0].branches[0].warehouse[0].stock_num = 0; },
    a => { a[0].branches[0].warehouse[0].stock_num = 2; },
    a => { a[0].branches[0].erpQty = 2; },
    a => { a[0].branches[0].warehouse[0].freeze_num = 1; },
    a => { a[0].branches[0].detail.sold_num = 1; },
  ]) { const { before, after } = fixture(); mutate(after); assert.equal(compareRepairAudits(before, after).ok, false); }
  const { before, after } = fixture(); before.push(product('other', 2)); after.push(product('other', 3));
  assert.equal(compareRepairAudits(before, after).ok, false);
});

test('wrong identity, price, barcode or visibility cannot pass', async () => {
  const { compareRepairAudits } = await load();
  for (const mutate of [
    a => { a[0].branches[0].detail.item_code = 'KORG'; },
    a => { a[0].branches[0].detail.kdt_id = 999; },
    a => { a[0].branches[0].detail.channel_item_id = 999; },
    a => { a[0].branches[0].detail.skus[0].price++; },
    a => { a[0].branches[0].detail.skus[0].sku_barcode = 'wrong'; },
    a => { a[0].branches[0].detail.display = 0; },
    a => { a[0].hqDetail.skus[0].price++; },
  ]) { const { before, after } = fixture(); mutate(after); assert.equal(compareRepairAudits(before, after).ok, false); }
});

test('JSONL and JSON arrays parse but noisy/truncated logs are rejected', async () => {
  const { parseAudit } = await load();
  assert.deepEqual(parseAudit('{"id":"a"}\n{"id":"b"}\n'), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(parseAudit('[{"id":"a"}]'), [{ id: 'a' }]);
  assert.throws(() => parseAudit('log\n{"id":"a"}'));
  assert.throws(() => parseAudit(''));
});

test('Kitty item barcode correction allowed; missing before HQ explicitly unproven', async () => {
  const { compareRepairAudits } = await load(); const { before, after } = fixture();
  delete before[0].hqDetail;
  before[0].branches[0].detail.item_barcode = 'P260927306036196';
  const result = compareRepairAudits(before, after);
  assert.equal(result.ok, true);
  assert.equal(result.expected_barcode_changes.length, 1);
  assert.equal(result.warnings[0].code, 'HQ_BEFORE_UNAVAILABLE');
});

test('channel stock string beats raw thousandths; WMS remains whole units', async () => {
  const { compareRepairAudits } = await load(); const { before, after } = fixture();
  for (let i = 0; i < 2; i++) {
    Object.assign(before[i].branches[0].detail.skus[0], { stock_num: 0, stock_num_str: '0' });
    Object.assign(after[i].branches[0].detail.skus[0], { stock_num: 1000, stock_num_str: '1' });
    after[i].branches[0].warehouse[0].stock_num = '1';
  }
  assert.equal(compareRepairAudits(before, after).ok, true);
  delete after[0].branches[0].detail.skus[0].stock_num_str;
  assert.equal(compareRepairAudits(before, after).ok, true);
  after[0].branches[0].detail.skus[0].stock_num_str = '2';
  assert.equal(compareRepairAudits(before, after).ok, false);
});

test('master SKU price or warehouse road quantity drift is not silently ignored', async () => {
  const { compareRepairAudits } = await load();
  for (const mutate of [
    (b, a) => { b[0].master.skus[0].retail_price = '399'; a[0].master.skus[0].retail_price = '398'; },
    (b, a) => { b[0].branches[0].warehouse[0].road_num = '0'; a[0].branches[0].warehouse[0].road_num = '1'; },
  ]) { const { before, after } = fixture(); mutate(before, after); assert.equal(compareRepairAudits(before, after).ok, false); }
});

test('in-progress KORG other stores may become absent, never be reported as untouched baseline', async () => {
  const { compareBranchAudits } = await load();
  const detail = product(ids[1], 0).branches[0].detail;
  const { normalizeVisibilityDetail } = await import('./audit-youzan-branch-visibility.mjs');
  const target = normalizeVisibilityDetail(detail, 212291308, detail.item_code);
  const before = { schema: 'youzan-branch-visibility-v1', ok: false, scope: [ids[1]],
    shops: [{ id: 't', kdt_id: 212291308 }, { id: 'o', kdt_id: 2 }], products: [{
      sku_id: ids[1], master_code: detail.item_code, target_kdts: [212291308], branches: [target,
        { ...structuredClone(target), kdt_id: 2, unexpected_visibility: true }] }] };
  const after = structuredClone(before); after.ok = true;
  after.products[0].branches[1] = { kdt_id: 2, state: 'absent' };
  const report = compareBranchAudits(before, after);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.expected_channel_removals.length, 1);
  assert.equal(report.baseline_kind, 'in_progress_scope_check');
  after.products[0].branches[1] = structuredClone(before.products[0].branches[1]);
  assert.equal(compareBranchAudits(before, after).ok, false);
});

test('all-branch report refuses newly visible, unknown, missing or changed other stores', async () => {
  const { compareBranchAudits } = await load();
  const base = { schema: 'youzan-branch-visibility-v1', ok: true, scope: [ids[0]],
    shops: [{ id: 'target', kdt_id: 212291308 }, { id: 'other', kdt_id: 2 }],
    products: [{ sku_id: ids[0], master_code: 'BM529821940370', target_kdts: [212291308],
      branches: [{ kdt_id: 212291308, state: 'present', display: 1, item_code: 'BM529821940370', item_id: 10,
        channel_item_id: 100, item_barcode: 'B', sold_num: 0, skus: [{ sku_id: 1, channel_sku_id: 2, sku_barcode: 'B', price: 100 }] },
      { kdt_id: 2, state: 'absent' }] }] };
  assert.equal(compareBranchAudits(base, structuredClone(base)).ok, true);
  for (const mutate of [
    a => { a.products[0].branches[1] = { ...a.products[0].branches[0], kdt_id: 2 }; },
    a => { a.products[0].branches[1].state = 'error'; },
    a => { a.products[0].branches.pop(); },
    a => { a.shops.pop(); },
    a => { a.scope.push(ids[1]); },
    a => { a.products[0].branches[0].skus[0].price++; },
  ]) { const after = structuredClone(base); mutate(after); assert.equal(compareBranchAudits(base, after).ok, false); }
});
