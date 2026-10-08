import assert from 'node:assert/strict';

const base = process.argv[2];
if (!base) throw new Error('Expected release URL');
const pages = async (query) => {
  const rows = [];
  let total;
  for (let page = 1; ; page++) {
    const response = await fetch(`${base}/api/public/storefront/products?${query}&page=${page}&page_size=100&media=tencent-v1`);
    assert.equal(response.status, 200, 'catalog returns 200');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.filters.fankuang, query === 'fankuang=1');
    total ??= body.pagination.total;
    assert.equal(body.pagination.total, total, 'pagination total stable');
    for (const row of body.data) {
      assert.equal(typeof row.in_fankuang, 'boolean');
      assert.ok(row.stock > 0, 'zero-stock items excluded');
      assert.notEqual(row.product_type, 'standard');
      rows.push(row);
    }
    if (rows.length >= total || body.data.length === 0) break;
    assert.ok(page < 100, 'bounded catalog read');
  }
  assert.equal(rows.length, total);
  assert.equal(new Set(rows.map(row => row.id)).size, total, 'no duplicate listings');
  return rows;
};
const all = await pages('fankuang=0');
const enrolled = await pages('fankuang=1');
assert.deepEqual(enrolled.map(row => row.id), all.filter(row => row.in_fankuang).map(row => row.id));
if (all.length) {
  const response = await fetch(`${base}/api/public/storefront/products/${all[0].id}?media=tencent-v1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.in_fankuang, all[0].in_fankuang);
  const image = all[0].cover_url;
  if (image) {
    const media = await fetch(image);
    assert.equal(media.status, 200, 'existing media still accessible');
    assert.ok(media.headers.get('content-type')?.startsWith('image/'));
  }
}
const api = await fetch(`${base}/api/public/handheld/openapi.json`).then(row => row.json());
const patch = JSON.stringify(api.paths['/items/{id}'] ?? api.paths['/handheld/items/{id}'] ?? api);
assert.ok(patch.includes('fankuang_override'), 'handheld schema exposes field');
console.log(JSON.stringify({ base, all: all.length, enrolled: enrolled.length, stockAndMediaGuards: 'passed', mutations: false }));
