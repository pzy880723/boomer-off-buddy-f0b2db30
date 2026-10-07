import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const INCIDENT = {
  sku: '4c50282c-e82a-41a3-ae3b-fe88a6fdea43',
  location: '2df58305-57c1-4792-9920-3c3aa49890bc',
  listing: '14509520-8be9-4a03-8c5d-49cca675677b',
  legacyKey: 'E20261006220408078900069#2#0',
};

export async function verifyRecovery({ base, database, token }, request = fetch) {
  assert.ok(['https://erp.boomeroff.com', 'http://127.0.0.1:3005', 'http://127.0.0.1:3006'].includes(base));
  assert.ok(database && token, 'Database read credentials required');
  const get = (url, init = {}) => request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(25000) });
  for (const route of ['youzan-sale-compensation', 'channel-sync-worker']) {
    const response = await get(`${base}/api/public/hooks/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401, `${route} must reject unauthenticated requests`);
  }
  const listing = await get(`${base}/api/public/storefront/products/${INCIDENT.listing}`);
  assert.equal(listing.status, 404, 'Sold product cannot be purchased');
  const search = await get(`${base}/api/public/storefront/products?q=${encodeURIComponent('奈良')}&page_size=100`);
  assert.equal(search.status, 200);
  const products = await search.json();
  assert.equal(products.ok, true);
  assert.ok(Array.isArray(products.data));
  assert.ok(!products.data.some(x => x.id === INCIDENT.listing || x.sku_id === INCIDENT.sku));
  const read = async (table, select, filters) => {
    const params = new URLSearchParams({ select, ...filters });
    const response = await get(`${database}/rest/v1/${table}?${params}`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200, `Read ${table}`);
    const rows = await response.json();
    assert.ok(Array.isArray(rows));
    return rows;
  };
  const stocks = await read('inv_stocks', 'qty,location_id', { sku_id: `eq.${INCIDENT.sku}` });
  assert.ok(stocks.some(x => x.location_id === INCIDENT.location));
  assert.ok(stocks.every(x => x.qty === 0), 'Sold isolated item must not have positive stock elsewhere');
  const [sku] = await read('inv_skus', 'is_display,sales_state,inventory_version', { id: `eq.${INCIDENT.sku}` });
  assert.equal(sku?.is_display, false);
  assert.ok(['sold', 'sold_syncing'].includes(sku.sales_state));
  assert.equal(Number(sku.inventory_version), 1, 'No repeated stock mutation');
  const listings = await read('commerce_listings', 'status', { sku_id: `eq.${INCIDENT.sku}` });
  assert.ok(listings.length > 0 && listings.every(x => x.status === 'sold'));
  const events = await read('inventory_sale_events', 'status,source_order_id', {
    sku_id: `eq.${INCIDENT.sku}`, event_type: 'eq.paid', status: 'eq.processed',
  });
  assert.equal(events.length, 1, 'Exactly one processed sale');
  assert.equal(events[0].source_order_id, INCIDENT.legacyKey);
  const movements = await read('inv_stock_movements', 'delta,balance_after', {
    sku_id: `eq.${INCIDENT.sku}`, delta: 'eq.-1',
  });
  assert.equal(movements.length, 1, 'Exactly one debit movement');
  assert.equal(movements[0].balance_after, 0);
  return { passed: true, publicSoldProductHidden: true, stock: 0, processedSales: 1, debitMovements: 1,
    state: sku.sales_state, writes: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await verifyRecovery({
      base: process.argv[2] ?? 'https://erp.boomeroff.com',
      database: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
      token: process.env.SUPABASE_SERVICE_ROLE_KEY,
    })));
  } catch (error) {
    console.error(error instanceof assert.AssertionError ? error.message : 'Recovery verification request failed');
    process.exitCode = 1;
  }
}
