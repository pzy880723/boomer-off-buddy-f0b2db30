import { yuanToFen } from './ordinary-payment-flow';
import { refundEvent, type OrdinaryRefund, type RefundPayment } from './ordinary-payment-notifications';
import type { RefundInput, WeChatRefund } from './wechat-ordinary-client';

interface RefundDependencies {
  merchantId: string; appId: string;
  store: { rpc(name: string, args: Record<string, unknown>): Promise<unknown> };
  client: { queryRefund(no: string): Promise<Record<string, unknown> | null>;
    refund(input: RefundInput): Promise<Record<string, unknown> | null> };
}
type RefundRow = OrdinaryRefund & { status: string };
function publicRefund(refund: RefundRow) {
  return { id: refund.id, payment_id: refund.payment_id, status: refund.status, amount: refund.amount };
}
function assertRoute(deps: RefundDependencies, refund: OrdinaryRefund, payment: RefundPayment) {
  if (payment.merchant_snapshot.mode !== 'ordinary_wechat' || payment.merchant_snapshot.merchant_id !== deps.merchantId
      || payment.merchant_snapshot.app_id !== deps.appId || refund.route_snapshot.merchant_id !== deps.merchantId
      || refund.route_snapshot.app_id !== deps.appId || refund.route_snapshot.mode !== 'ordinary_wechat')
    throw new Error('Historical refund snapshot mismatch');
}
async function recordResponse(deps: RefundDependencies, response: Record<string, unknown> | null,
  refund: RefundRow, payment: RefundPayment, leaseToken: string | null) {
  const amount = response?.amount as { total?: number; refund?: number; currency?: string } | undefined;
  if (!response || response.out_refund_no !== refund.merchant_refund_no || response.out_trade_no !== payment.merchant_order_no
      || response.transaction_id !== payment.provider_transaction_id || typeof response.refund_id !== 'string' || !response.refund_id
      || amount?.total !== yuanToFen(payment.amount) || amount.refund !== yuanToFen(refund.amount) || amount.currency !== 'CNY'
      || (response.mchid !== undefined && response.mchid !== deps.merchantId)) throw new Error('Refund response mismatch');
  if (response.status === 'PROCESSING') {
    if (leaseToken) await deps.store.rpc('commerce_record_ordinary_refund', { p_refund_id: refund.id,
      p_lease_token: leaseToken, p_provider_refund_id: response.refund_id });
    return publicRefund(refund);
  }
  if (!['SUCCESS', 'ABNORMAL', 'CLOSED'].includes(String(response.status))) throw new Error('Refund status mismatch');
  // The signed domestic refund response omits mchid; the authenticated request
  // and persisted route identify it. Never use an unsigned client-provided value.
  const data = { ...response, mchid: deps.merchantId, refund_status: response.status } as WeChatRefund;
  const event = refundEvent(`query-refund:${response.refund_id}:${response.status}`, data, refund, payment);
  const result = await deps.store.rpc('commerce_apply_ordinary_refund', { p_event: event }) as { refund: RefundRow };
  return publicRefund(result.refund);
}
export async function reconcileOrdinaryRefund(deps: RefundDependencies, refund: RefundRow, payment: RefundPayment) {
  assertRoute(deps, refund, payment);
  if (['succeeded', 'cancelled'].includes(refund.status)) return publicRefund(refund);
  return recordResponse(deps, await deps.client.queryRefund(refund.merchant_refund_no), refund, payment, null);
}
export async function startOrdinaryRefund(deps: RefundDependencies, input: {
  paymentId: string; afterSaleId: string; idempotencyKey: string; operatorId: string; roles: string[];
}) {
  if (!input.roles.some(role => role === 'super_admin' || role === 'hq_operator')) throw new Error('Refund permission denied');
  const prepared = await deps.store.rpc('commerce_prepare_ordinary_refund', { p_payment_id: input.paymentId,
    p_after_sale_id: input.afterSaleId, p_idempotency_key: input.idempotencyKey, p_operator_id: input.operatorId,
  }) as { payment: RefundPayment; refund: RefundRow; acquired: boolean; lease_token: string | null };
  const { payment, refund } = prepared;
  assertRoute(deps, refund, payment);
  if (payment.id !== input.paymentId || refund.payment_id !== payment.id) throw new Error('Refund payment mismatch');
  if (!prepared.acquired || !prepared.lease_token) return publicRefund(refund);
  let response: Record<string, unknown> | null;
  try { response = await deps.client.queryRefund(refund.merchant_refund_no); }
  catch (error) {
    if ((error as { code?: string }).code !== 'RESOURCE_NOT_EXISTS') throw error;
    response = await deps.client.refund({ orderNo: payment.merchant_order_no, refundNo: refund.merchant_refund_no,
      totalFen: yuanToFen(payment.amount), refundFen: yuanToFen(refund.amount), reason: '商城审核通过的售后退款' });
  }
  return recordResponse(deps, response, refund, payment, prepared.lease_token);
}
