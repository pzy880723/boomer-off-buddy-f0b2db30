import type { CreatePaymentInput } from './wechat-ordinary-client';

export interface OrdinaryPayment {
  id: string; order_id: string; status: string; amount: number | string; currency: string;
  merchant_order_no: string; payer_openid: string;
  merchant_snapshot: { mode: string; merchant_id: string; app_id: string };
  expires_at: string; prepay_id: string | null; payment_payload: Record<string, unknown>;
  lease_expires_at?: string | null;
}
export interface OrdinaryDependencies {
  merchantId: string; appId: string;
  store: { rpc(name: string, args: Record<string, unknown>): Promise<unknown> };
  client: {
    queryPayment(orderNo: string): Promise<Record<string, unknown> | null>;
    closePayment(orderNo: string): Promise<unknown>;
    createPayment(input: CreatePaymentInput): Promise<{ prepay_id: string; payment_payload: Record<string, unknown> }>;
  };
}
interface StartInput {
  orderId: string; customerId: string; idempotencyKey: string; platform: string;
  miniOpenId: string | null; miniAppId: string | null;
}
export function yuanToFen(value: string | number) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Invalid payment amount');
  const [whole, decimal = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid payment amount');
  return result;
}
function assertSnapshot(deps: OrdinaryDependencies, payment: OrdinaryPayment) {
  const route = payment.merchant_snapshot;
  if (route?.mode !== 'ordinary_wechat' || route.merchant_id !== deps.merchantId || route.app_id !== deps.appId)
    throw new Error('Historical payment snapshot is not configured');
  if (payment.currency !== 'CNY' || !Number.isFinite(Date.parse(payment.expires_at))) throw new Error('Invalid payment snapshot');
}
function publicResult(payment: OrdinaryPayment) {
  const source = payment.payment_payload ?? {};
  const payload: Record<string, unknown> = {};
  if (payment.prepay_id && source.package === `prepay_id=${payment.prepay_id}` && source.signType === 'RSA') {
    for (const key of ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign']) {
      if (typeof source[key] !== 'string' || !source[key]) throw new Error('Invalid stored payment payload');
      payload[key] = source[key];
    }
  }
  return { payment: { id: payment.id, order_id: payment.order_id, provider: 'wechat', status: payment.status,
    amount: payment.amount, currency: payment.currency }, payment_payload: payload, expires_at: payment.expires_at };
}
function processing(): never {
  throw Object.assign(new Error('Payment processing; query original order before retrying'), { code: 'payment_processing' });
}
function validateTransaction(transaction: Record<string, unknown>, payment: OrdinaryPayment) {
  const amount = transaction.amount as { total?: number; currency?: string } | undefined;
  if (transaction.mchid !== payment.merchant_snapshot.merchant_id || transaction.appid !== payment.merchant_snapshot.app_id
      || transaction.out_trade_no !== payment.merchant_order_no || amount?.total !== yuanToFen(payment.amount)
      || amount?.currency !== 'CNY') throw new Error('Payment response snapshot mismatch');
}
export function paymentEvent(id: string, transaction: Record<string, unknown>, payment: OrdinaryPayment) {
  validateTransaction(transaction, payment);
  const payer = transaction.payer as { openid?: string } | undefined;
  if (transaction.trade_state !== 'SUCCESS' || typeof transaction.transaction_id !== 'string' || !transaction.transaction_id
      || payer?.openid !== payment.payer_openid || typeof transaction.success_time !== 'string'
      || !Number.isFinite(Date.parse(transaction.success_time))) throw new Error('Payment event mismatch or invalid paid time');
  return { event_id: id, merchant_order_no: payment.merchant_order_no, merchant_id: payment.merchant_snapshot.merchant_id,
    app_id: payment.merchant_snapshot.app_id, currency: 'CNY', total_fen: yuanToFen(payment.amount),
    transaction_id: transaction.transaction_id, status: 'succeeded', paid_at: transaction.success_time, payer_openid: payer.openid };
}
async function query(deps: OrdinaryDependencies, payment: OrdinaryPayment) {
  try {
    const result = await deps.client.queryPayment(payment.merchant_order_no);
    if (!result) throw new Error('Empty payment query response');
    return result;
  }
  catch (error) {
    if ((error as { code?: string }).code === 'ORDERNOTEXIST') return null;
    throw error;
  }
}
async function settleQuery(deps: OrdinaryDependencies, payment: OrdinaryPayment, transaction: Record<string, unknown> | null) {
  if (transaction) validateTransaction(transaction, payment);
  if (transaction?.trade_state === 'SUCCESS') {
    const event = paymentEvent(`query:${transaction.transaction_id}`, transaction, payment);
    const result = await deps.store.rpc('commerce_apply_ordinary_payment', { p_event: event }) as { payment: OrdinaryPayment };
    return result.payment;
  }
  const expiring = Date.parse(payment.expires_at) - Date.now() < 60000;
  if (!transaction && !payment.prepay_id && Date.parse(payment.expires_at) + 120000 <= Date.now()
      && (!payment.lease_expires_at || Date.parse(payment.lease_expires_at) <= Date.now())) {
    return await deps.store.rpc('commerce_close_ordinary_payment', { p_payment_id: payment.id,
      p_close_evidence: { merchant_order_no: payment.merchant_order_no, merchant_id: deps.merchantId,
        status: 'NOT_FOUND', checked_at: new Date().toISOString() },
    }) as OrdinaryPayment;
  }
  if (transaction?.trade_state === 'CLOSED' || (expiring && (!transaction || transaction.trade_state === 'NOTPAY'))) {
    // Even a signed NOTEXIST alone cannot release stock: a prior create may still
    // be in flight. Require a confirmed close or signed CLOSED response.
    if (transaction?.trade_state !== 'CLOSED') await deps.client.closePayment(payment.merchant_order_no);
    return await deps.store.rpc('commerce_close_ordinary_payment', {
      p_payment_id: payment.id,
      p_close_evidence: { merchant_order_no: payment.merchant_order_no, merchant_id: deps.merchantId, status: 'CLOSED' },
    }) as OrdinaryPayment;
  }
  return payment;
}
export async function reconcileOrdinaryPayment(deps: OrdinaryDependencies, payment: OrdinaryPayment) {
  assertSnapshot(deps, payment);
  if (['succeeded', 'refunded', 'partially_refunded', 'cancelled'].includes(payment.status)) return payment;
  return settleQuery(deps, payment, await query(deps, payment));
}
export async function startOrdinaryPayment(deps: OrdinaryDependencies, input: StartInput) {
  if (input.platform !== 'miniapp' || !input.miniOpenId || input.miniAppId !== deps.appId)
    throw Object.assign(new Error('Trusted mini-program login required'), { code: 'mini_login_required' });
  const prepared = await deps.store.rpc('commerce_prepare_ordinary_payment', {
    p_order_id: input.orderId, p_customer_id: input.customerId, p_idempotency_key: input.idempotencyKey, p_openid: input.miniOpenId,
  }) as { payment: OrdinaryPayment; acquired: boolean; lease_token: string | null };
  let payment = prepared.payment;
  assertSnapshot(deps, payment);
  if (payment.order_id !== input.orderId || payment.payer_openid !== input.miniOpenId) throw new Error('Payment identity mismatch');
  if (['succeeded', 'refunded', 'partially_refunded', 'cancelled'].includes(payment.status)) return publicResult(payment);
  if (payment.prepay_id && Date.parse(payment.expires_at) - Date.now() >= 60000
      && Object.keys(publicResult(payment).payment_payload).length) return publicResult(payment);
  if (!prepared.acquired || !prepared.lease_token) return processing();
  const transaction = await query(deps, payment);
  payment = await settleQuery(deps, payment, transaction);
  if (['succeeded', 'refunded', 'partially_refunded', 'cancelled'].includes(payment.status)) return publicResult(payment);
  if (Date.parse(payment.expires_at) - Date.now() < 60000) return processing();
  if (transaction) {
    if (transaction.trade_state === 'NOTPAY' && payment.prepay_id && Object.keys(publicResult(payment).payment_payload).length)
      return publicResult(payment);
    if (transaction.trade_state === 'NOTPAY' && !payment.prepay_id) {
      // The first prepay response was lost. Close the original unpaid order
      // before letting the user place a fresh order; never invent a second ID.
      await deps.client.closePayment(payment.merchant_order_no);
      const closed = await deps.store.rpc('commerce_close_ordinary_payment', { p_payment_id: payment.id,
        p_close_evidence: { merchant_order_no: payment.merchant_order_no, merchant_id: deps.merchantId, status: 'CLOSED' },
      }) as OrdinaryPayment;
      return publicResult(closed);
    }
    return processing();
  }
  const created = await deps.client.createPayment({ orderNo: payment.merchant_order_no, totalFen: yuanToFen(payment.amount),
    openid: input.miniOpenId, description: 'BOOMER OFF 官方商城商品', expiresAt: payment.expires_at });
  const stored = await deps.store.rpc('commerce_record_ordinary_prepay', { p_payment_id: payment.id,
    p_lease_token: prepared.lease_token, p_prepay_id: created.prepay_id, p_payment_payload: created.payment_payload,
    p_expires_at: payment.expires_at }) as OrdinaryPayment;
  return publicResult(stored);
}
