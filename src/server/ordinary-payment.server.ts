import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { ordinaryMerchantConfig, ordinaryPaymentSecrets } from './ordinary-payment-config';
import { createWeChatPayClient } from './wechat-ordinary-client';
import { ordinaryGatewayConfig } from './ordinary-gateway-config';
import { createOrdinaryGatewayClient } from './ordinary-gateway-client';

import type { OrdinaryPayment } from './ordinary-payment-flow';
import type { NotificationStore, OrdinaryRefund, RefundPayment } from './ordinary-payment-notifications';

export async function ordinaryRpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name as never, args as never);
  if (error) throw Object.assign(new Error('Ordinary payment ledger operation rejected'), { code: error.code });
  return data as unknown;
}
export const ordinaryStore: NotificationStore = {
  rpc: ordinaryRpc,
  async findPayment(orderNo) {
    const { data, error } = await supabaseAdmin.from('commerce_payments' as never).select('*')
      .eq('payment_channel', 'ordinary_wechat').eq('merchant_order_no', orderNo).maybeSingle();
    if (error) throw new Error('Payment ledger unavailable');
    return data as OrdinaryPayment | null;
  },
  async findRefund(refundNo) {
    const { data, error } = await supabaseAdmin.from('commerce_refunds' as never).select('*')
      .eq('merchant_refund_no', refundNo).maybeSingle();
    if (error) throw new Error('Refund ledger unavailable');
    if (!data) return null;
    const refund = data as OrdinaryRefund;
    const result = await supabaseAdmin.from('commerce_payments' as never).select('*')
      .eq('payment_channel', 'ordinary_wechat').eq('id', refund.payment_id).maybeSingle();
    if (result.error || !result.data) throw new Error('Original payment unavailable');
    return { refund, payment: result.data as RefundPayment };
  },
};
let cached: { createPayment: unknown } | null = null;
export function ordinaryPaymentRuntime() {
  // Independent of default new-order mode: historical ordinary orders still
  // query/refund using this merchant when the storefront later switches to split.
  const settings = ordinaryMerchantConfig(process.env);
  if (!cached) {
    const gateway = ordinaryGatewayConfig(process.env);
    // 优先走腾讯云网关：微信私钥 / APIv3 密钥不落地 ERP。
    cached = gateway
      ? createOrdinaryGatewayClient({ ...gateway, merchantId: settings.merchantId, appId: settings.appId })
      : createWeChatPayClient({ ...settings, ...ordinaryPaymentSecrets(process.env),
          refundNotifyUrl: settings.notifyUrl });
  }
  return { ...settings, client: cached as ReturnType<typeof createWeChatPayClient>, store: ordinaryStore };
}

export async function readNotificationBody(request: Request) {
  const limit = 64 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new Error('Notification too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Empty notification');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Notification too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
