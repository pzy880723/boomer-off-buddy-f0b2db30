import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOrdinaryPayment, reconcileOrdinaryPayment, paymentEvent } from './ordinary-payment-flow';

function fixture() {
  const payment = { id: 'p1', order_id: 'o1', status: 'processing', amount: '12.34', currency: 'CNY',
    merchant_order_no: '01234567890123456789012345678901', payer_openid: 'trusted-mini',
    merchant_snapshot: { mode: 'ordinary_wechat', merchant_id: '1749999844', app_id: 'wx-mini' },
    expires_at: new Date(Date.now() + 600000).toISOString(), prepay_id: null,
    payment_payload: {} as Record<string, unknown> };
  const calls: string[] = [];
  const store = { async rpc(name: string, args: Record<string, any>): Promise<any> {
    calls.push(name);
    if (name === 'commerce_prepare_ordinary_payment') return { payment, acquired: true, lease_token: 'lease' };
    if (name === 'commerce_record_ordinary_prepay') { Object.assign(payment, { prepay_id: args.p_prepay_id, payment_payload: args.p_payment_payload }); return payment; }
    if (name === 'commerce_apply_ordinary_payment') { payment.status = 'succeeded'; return { payment, replayed: false }; }
    if (name === 'commerce_close_ordinary_payment') { payment.status = 'cancelled'; return payment; }
    throw new Error(`Unexpected RPC ${name}`);
  } };
  const missing = () => Object.assign(new Error('not found'), { code: 'ORDERNOTEXIST' });
  const client = {
    async queryPayment(_no: string): Promise<any> { calls.push('query'); throw missing(); },
    async createPayment(input: any) { calls.push('create'); assert.equal(input.openid, 'trusted-mini'); assert.equal(input.totalFen, 1234); assert.equal(input.orderNo, payment.merchant_order_no);
      return { prepay_id: 'prepay', payment_payload: { timeStamp: '123', nonceStr: 'nonce', package: 'prepay_id=prepay', signType: 'RSA', paySign: 'signature' } }; },
    async closePayment(_no: string) { calls.push('close'); return null; },
  };
  const deps = { store, client, merchantId: '1749999844', appId: 'wx-mini' };
  const input = { orderId: 'o1', customerId: 'c1', idempotencyKey: 'key', platform: 'miniapp', miniOpenId: 'trusted-mini', miniAppId: 'wx-mini' };
  const success = () => ({ mchid: '1749999844', appid: 'wx-mini', out_trade_no: payment.merchant_order_no,
    trade_state: 'SUCCESS', transaction_id: 'tx1', amount: { total: 1234, currency: 'CNY' },
    payer: { openid: 'trusted-mini' }, success_time: new Date().toISOString() });
  return { payment, calls, store, client, deps, input, success };
}

test('trusted mini identity required before any database or payment action', async () => {
  for (const change of [{ miniOpenId: null }, { miniAppId: 'wx-other' }, { platform: 'app' }]) {
    const f = fixture();
    await assert.rejects(startOrdinaryPayment(f.deps, { ...f.input, ...change }), /mini/i);
    assert.deepEqual(f.calls, []);
  }
});
test('query original merchant order before first create; return no private snapshot', async () => {
  const f = fixture(); const result = await startOrdinaryPayment(f.deps, f.input);
  assert.deepEqual(f.calls, ['commerce_prepare_ordinary_payment', 'query', 'create', 'commerce_record_ordinary_prepay']);
  assert.equal(result.payment.id, 'p1'); assert.equal(result.payment_payload.package, 'prepay_id=prepay');
  assert.equal('merchant_snapshot' in result.payment, false); assert.equal('payer_openid' in result.payment, false);
});
test('unknown query never creates or releases inventory', async () => {
  const f = fixture(); f.client.queryPayment = async () => { throw new Error('timeout'); };
  await assert.rejects(startOrdinaryPayment(f.deps, f.input), /timeout/);
  assert.deepEqual(f.calls, ['commerce_prepare_ordinary_payment']);
});
test('empty success response is not treated as ORDERNOTEXIST', async () => {
  const f = fixture(); f.client.queryPayment = async () => null;
  await assert.rejects(startOrdinaryPayment(f.deps, f.input), /empty/i);
  assert.equal(f.calls.includes('create'), false);
});
test('lost create response leaves durable processing; never marks failure', async () => {
  const f = fixture(); f.client.createPayment = async () => { throw new Error('unknown result'); };
  await assert.rejects(startOrdinaryPayment(f.deps, f.input), /unknown result/);
  assert.equal(f.payment.status, 'processing'); assert.equal(f.calls.includes('commerce_close_ordinary_payment'), false);
});
test('concurrent request cannot submit another prepay', async () => {
  const f = fixture(); f.store.rpc = async () => ({ payment: f.payment, acquired: false, lease_token: null });
  await assert.rejects(startOrdinaryPayment(f.deps, f.input), /processing/i);
  assert.deepEqual(f.calls, []);
});
test('durable valid prepay can replay without reacquiring the lease', async () => {
  const f = fixture(); const created = await f.client.createPayment({ orderNo: f.payment.merchant_order_no, totalFen: 1234, openid: 'trusted-mini' });
  Object.assign(f.payment, created); f.calls.length = 0;
  f.store.rpc = async () => ({ payment: f.payment, acquired: false, lease_token: null });
  const result = await startOrdinaryPayment(f.deps, f.input);
  assert.equal(result.payment_payload.package, 'prepay_id=prepay'); assert.deepEqual(f.calls, []);
});
test('successful query reconciles instead of charging again', async () => {
  const f = fixture(); f.client.queryPayment = async () => f.success();
  const result = await startOrdinaryPayment(f.deps, f.input);
  assert.equal(result.payment.status, 'succeeded'); assert.equal(f.calls.includes('create'), false);
  assert.equal(f.calls.includes('commerce_apply_ordinary_payment'), true);
});
test('lost prepay closes confirmed unpaid intent so customer can create a fresh order', async () => {
  const f = fixture(); f.client.queryPayment = async () => ({ ...f.success(), trade_state: 'NOTPAY' });
  const result = await startOrdinaryPayment(f.deps, f.input);
  assert.equal(result.payment.status, 'cancelled');
  assert.ok(f.calls.indexOf('close') < f.calls.indexOf('commerce_close_ordinary_payment'));
  assert.equal(f.calls.includes('create'), false);
});
test('verified missing order is recoverable only beyond expiry grace without prepay or active lease', async () => {
  const f = fixture(); f.payment.expires_at = new Date(Date.now() - 180000).toISOString();
  const oldRpc = f.store.rpc; f.store.rpc = async (name, args) => {
    if (name === 'commerce_close_ordinary_payment') {
      assert.equal(args.p_close_evidence.status, 'NOT_FOUND'); assert.ok(Date.parse(args.p_close_evidence.checked_at));
    }
    return oldRpc(name, args);
  };
  const result = await reconcileOrdinaryPayment(f.deps, f.payment);
  assert.equal(result.status, 'cancelled'); assert.equal(f.calls.includes('close'), false);
});
test('expired unpaid intent is closed before releasing reservation', async () => {
  const f = fixture(); f.payment.expires_at = new Date(Date.now() - 1000).toISOString();
  f.client.queryPayment = async () => ({ ...f.success(), trade_state: 'NOTPAY' });
  const result = await reconcileOrdinaryPayment(f.deps, f.payment);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(f.calls, ['close', 'commerce_close_ordinary_payment']);
});
test('close timeout keeps reservation and payment pending', async () => {
  const f = fixture(); f.payment.expires_at = new Date(Date.now() - 1000).toISOString();
  f.client.queryPayment = async () => ({ ...f.success(), trade_state: 'NOTPAY' });
  f.client.closePayment = async () => { throw new Error('timeout'); };
  await assert.rejects(reconcileOrdinaryPayment(f.deps, f.payment), /timeout/);
  assert.deepEqual(f.calls, []); assert.equal(f.payment.status, 'processing');
});
test('historical merchant snapshot mismatch fails without querying another channel', async () => {
  const f = fixture(); f.payment.merchant_snapshot.merchant_id = 'other';
  await assert.rejects(reconcileOrdinaryPayment(f.deps, f.payment), /snapshot/i);
  assert.deepEqual(f.calls, []);
});
test('payment event verifies merchant, app, order, amount, currency, payer and paid time', () => {
  const f = fixture(); const event = paymentEvent('event', f.success(), f.payment);
  assert.equal(event.total_fen, 1234); assert.equal(event.payer_openid, 'trusted-mini');
  for (const change of [{ mchid: 'other' }, { appid: 'other' }, { out_trade_no: 'other' },
    { amount: { total: 1, currency: 'CNY' } }, { amount: { total: 1234, currency: 'USD' } },
    { payer: { openid: 'attacker' } }, { success_time: 'invalid' }]) {
    assert.throws(() => paymentEvent('event', { ...f.success(), ...change }, f.payment), /mismatch|invalid/i);
  }
});
