import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOrdinaryNotification } from './ordinary-payment-notifications';
const payment = { id: 'p1', order_id: 'o1', status: 'succeeded', amount: '10.00', currency: 'CNY',
  merchant_order_no: 'order123', payer_openid: 'mini', provider_transaction_id: 'tx1',
  merchant_snapshot: { mode: 'ordinary_wechat', merchant_id: '12345678', app_id: 'wxmini' },
  expires_at: '', prepay_id: null, payment_payload: {} };
const refund = { id: 'r1', payment_id: 'p1', merchant_refund_no: 'refund123', amount: '5.00',
  route_snapshot: payment.merchant_snapshot };
const event = { id: 'notify123', eventType: 'REFUND.SUCCESS' as const, data: { mchid: '12345678', out_trade_no: 'order123',
  transaction_id: 'tx1', out_refund_no: 'refund123', refund_id: 'wxrefund', refund_status: 'SUCCESS' as const,
  success_time: '2026-09-08T01:00:00Z', amount: { total: 1000, refund: 500, currency: 'CNY' } } };
function fixture() {
  const writes: Array<{ name: string; args: any }> = [];
  const deps = { async findPayment(_no: string) { return payment; }, async findRefund(_no: string) { return { refund, payment }; },
    async rpc(name: string, args: any) { writes.push({ name, args }); return { replayed: false }; } };
  return { deps, writes };
}
test('refund success uses persisted amount, original transaction and atomic RPC', async () => {
  const f = fixture(); await applyOrdinaryNotification(f.deps, event);
  assert.equal(f.writes[0].name, 'commerce_apply_ordinary_refund');
  assert.equal(f.writes[0].args.p_event.refund_fen, 500); assert.equal(f.writes[0].args.p_event.status, 'succeeded');
});
test('abnormal or closed is not recorded as refunded', async () => {
  for (const [state, status] of [['ABNORMAL', 'failed'], ['CLOSED', 'cancelled']] as const) {
    const f = fixture(); await applyOrdinaryNotification(f.deps, { ...event, eventType: `REFUND.${state}`, data: { ...event.data, refund_status: state } });
    assert.equal(f.writes[0].args.p_event.status, status);
  }
});
test('mismatched refund evidence never writes a ledger', async () => {
  for (const change of [{ mchid: 'other' }, { transaction_id: 'other' }, { out_trade_no: 'other' },
    { amount: { total: 1000, refund: 1000, currency: 'CNY' } }]) {
    const f = fixture(); await assert.rejects(applyOrdinaryNotification(f.deps, { ...event, data: { ...event.data, ...change } }), /mismatch/i);
    assert.equal(f.writes.length, 0);
  }
});
test('missing payment or database failure must not acknowledge notification', async () => {
  const f = fixture(); f.deps.rpc = async () => { throw new Error('database offline'); };
  await assert.rejects(applyOrdinaryNotification(f.deps, event), /database offline/);
});
