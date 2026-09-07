import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { authenticatePosUser } from '@/server/pos-auth.server';
import { ordinaryPaymentRuntime } from '@/server/ordinary-payment.server';
import { startOrdinaryRefund } from '@/server/ordinary-refund-flow';
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
    try {
      const data = await startOrdinaryRefund(ordinaryPaymentRuntime(), { paymentId: body.payment_id,
        afterSaleId: body.after_sale_id, idempotencyKey: key, operatorId: auth.user.id, roles: auth.roles });
      return storefrontJson({ ok: true, data });
    } catch { return storefrontError('退款状态待确认，请勿重复创建退款申请', 503, 'refund_processing'); }
  },
} } });
