import assert from 'node:assert/strict';

// Read-only: never call refund, stock, order-transition or messaging endpoints.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && key, 'Server database configuration required');
async function rows(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: {apikey: key, Authorization: `Bearer ${key}`},
  });
  assert.equal(response.status, 200, path.split('?')[0]);
  return response.json();
}
const orders = await rows('commerce_orders?select=id,payment_status,order_status,source_channel,metadata,total_amount');
const refunds = await rows('commerce_refunds?select=id,order_id,payment_id,status,amount');
const payments = await rows('commerce_payments?select=id,order_id,status,amount');
const audit = await rows('commerce_order_status_audit?select=order_id,from_status,to_status,reason');
const origins = await rows('commerce_order_origin_audit?select=order_id,reason,new_sales_origin');
const fullyRefunded = orders.filter(order => order.payment_status === 'refunded');
for (const order of fullyRefunded) {
  assert.ok(['closed', 'cancelled'].includes(order.order_status), 'Fully refunded order still actionable');
  const paid = payments.filter(payment => payment.order_id === order.id && ['succeeded', 'partially_refunded', 'refunded'].includes(payment.status));
  const successful = refunds.filter(refund => refund.order_id === order.id && refund.status === 'succeeded');
  const fen = amount => Math.round(Number(amount) * 100);
  assert.equal(paid.reduce((sum, payment) => sum + fen(payment.amount), 0), fen(order.total_amount));
  assert.equal(successful.reduce((sum, refund) => sum + fen(refund.amount), 0), fen(order.total_amount));
}
const backfills = audit.filter(entry => entry.reason === 'backfill_full_refund_ledger_verified');
assert.equal(new Set(backfills.map(entry => entry.order_id)).size, backfills.length, 'Duplicate status backfill audit');
const sourceBackfills = origins.filter(entry => entry.reason === 'backfill_verified_miniapp_payment');
for (const entry of sourceBackfills) {
  const order = orders.find(order => order.id === entry.order_id);
  assert.equal(order?.metadata?.sales_origin?.platform, 'miniapp');
  assert.equal(order?.metadata?.sales_origin?.evidence, 'verified_miniapp_payment');
}
console.log(JSON.stringify({
  ok: true, read_only: true, order_count: orders.length,
  online_order_count: orders.filter(order => order.source_channel !== 'pos').length,
  fully_refunded: fullyRefunded.length, status_backfills: backfills.length,
  verified_source_backfills: sourceBackfills.length,
  successful_refunds: refunds.filter(refund => refund.status === 'succeeded').length,
}));
