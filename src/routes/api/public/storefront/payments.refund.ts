import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { authenticatePosUser } from '@/server/pos-auth.server';
import { ordinaryPaymentRuntime } from '@/server/ordinary-payment.server';
import { startOrdinaryRefund } from '@/server/ordinary-refund-flow';
import { PaymentRouteError, resolvePaymentChannel } from '@/server/payment-route';
import { storefrontError, storefrontJson, STOREFRONT_CORS } from '@/server/storefront-auth.server';

export const Route = createFileRoute('/api/public/storefront/payments/refund')({ server: { handlers: {
  OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
  POST: async ({ request }) => {
    const auth = await authenticatePosUser(request);
    if (!auth.ok) return auth.response;
    if (!auth.roles.some(role => role === 'super_admin' || role === 'hq_operator')) return storefrontError('仅总部可执行退款', 403);
    const key = request.headers.get('idempotency-key')?.trim();
    if (!key || key.length > 200) return storefrontError('Invalid Idempotency-Key', 400);
    let body;
    try { body = z.object({ payment_id: z.string().uuid(), after_sale_id: z.string().uuid() }).parse(await request.json()); }
    catch { return storefrontError('Invalid approved refund', 400); }
    // 通道以原支付记录为准，绝不读取当前全局开关重新解释历史订单。
    const record = await supabaseAdmin.from('commerce_payments' as never)
      .select('id,order_id,payment_channel,merchant_snapshot').eq('id', body.payment_id).maybeSingle();
    if (record.error) return storefrontError('支付记录暂不可用', 503);
    if (!record.data) return storefrontError('Payment not found', 404);
    let channel;
    try { channel = resolvePaymentChannel(record.data as never); }
    catch (error) {
      const code = error instanceof PaymentRouteError ? error.code : 'payment_route_unknown';
      return storefrontError('原支付通道无法确认，请人工核实后处理', 409, code);
    }
    if (channel !== 'ordinary_wechat') {
      return storefrontError('该订单为分账通道支付，请按原分账通道退款/回退', 409, 'legacy_split_refund_required');
    }
    try {
      const data = await startOrdinaryRefund(ordinaryPaymentRuntime(), { paymentId: body.payment_id,
        afterSaleId: body.after_sale_id, idempotencyKey: key, operatorId: auth.user.id, roles: auth.roles });
      return storefrontJson({ ok: true, data });
    } catch { return storefrontError('退款状态待确认，请勿重复创建退款申请', 503, 'refund_processing'); }
  },
} } });

