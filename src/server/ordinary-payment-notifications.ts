import { paymentEvent, yuanToFen, type OrdinaryPayment } from './ordinary-payment-flow';
import type { DecodedNotification, WeChatRefund } from './wechat-ordinary-client';

export interface OrdinaryRefund {
  id: string; payment_id: string; merchant_refund_no: string; amount: number | string;
  route_snapshot: { mode: string; merchant_id: string; app_id: string };
}
export type RefundPayment = OrdinaryPayment & { provider_transaction_id: string };
export interface NotificationStore {
  findPayment(orderNo: string): Promise<OrdinaryPayment | null>;
  findRefund(refundNo: string): Promise<{ refund: OrdinaryRefund; payment: RefundPayment } | null>;
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export function refundEvent(id: string, data: WeChatRefund, refund: OrdinaryRefund, payment: RefundPayment) {
  if (refund.route_snapshot.mode !== 'ordinary_wechat' || payment.merchant_snapshot.mode !== 'ordinary_wechat'
      || refund.route_snapshot.merchant_id !== data.mchid || payment.merchant_snapshot.merchant_id !== data.mchid
      || refund.route_snapshot.app_id !== payment.merchant_snapshot.app_id || refund.payment_id !== payment.id
      || data.out_trade_no !== payment.merchant_order_no || data.out_refund_no !== refund.merchant_refund_no
      || data.transaction_id !== payment.provider_transaction_id || !data.refund_id
      || data.amount.total !== yuanToFen(payment.amount) || data.amount.refund !== yuanToFen(refund.amount)
      || (data.amount.currency !== undefined && data.amount.currency !== 'CNY')) throw new Error('Refund snapshot mismatch');
  const status = { SUCCESS: 'succeeded', ABNORMAL: 'failed', CLOSED: 'cancelled' }[data.refund_status];
  if (!status) throw new Error('Refund status mismatch');
  if (status === 'succeeded' && (typeof data.success_time !== 'string' || !Number.isFinite(Date.parse(data.success_time))))
    throw new Error('Refund completion time mismatch');
  return { event_id: id, merchant_refund_no: refund.merchant_refund_no, merchant_id: data.mchid,
    transaction_id: data.transaction_id, provider_refund_id: data.refund_id, status,
    total_fen: yuanToFen(payment.amount), refund_fen: yuanToFen(refund.amount),
    refunded_at: status === 'succeeded' ? data.success_time : null };
}
// Only call this after protocol.decodeNotification has authenticated and decrypted
// the raw body. Acknowledgment belongs after this durable RPC, including replays.
export async function applyOrdinaryNotification(store: NotificationStore, event: DecodedNotification): Promise<void> {
  if (event.eventType === 'TRANSACTION.SUCCESS') {
    const payment = await store.findPayment(event.data.out_trade_no);
    if (!payment || payment.merchant_snapshot.mode !== 'ordinary_wechat') throw new Error('Ordinary payment not found');
    await store.rpc('commerce_apply_ordinary_payment', { p_event: paymentEvent(event.id, event.data, payment) });
  } else {
    const found = await store.findRefund(event.data.out_refund_no);
    if (!found) throw new Error('Ordinary refund not found');
    await store.rpc('commerce_apply_ordinary_refund', { p_event: refundEvent(event.id, event.data, found.refund, found.payment) });
  }
}
