import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { ordinaryPaymentRuntime } from '@/server/ordinary-payment.server';
import { reconcileOrdinaryPayment, type OrdinaryPayment } from '@/server/ordinary-payment-flow';
import { authenticateStorefrontCustomer, STOREFRONT_CORS, storefrontError, storefrontJson } from '@/server/storefront-auth.server';

export const Route = createFileRoute('/api/public/storefront/payments/reconcile')({
  server: { handlers: {
    OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
    POST: async ({ request }) => {
      const auth = await authenticateStorefrontCustomer(request);
      if (!auth.ok) return auth.response;
      let orderId: string;
      try { orderId = z.object({ order_id: z.string().uuid() }).parse(await request.json()).order_id; }
      catch { return storefrontError('Invalid order', 400); }
      const order = await supabaseAdmin.from('commerce_orders' as never).select('id')
        .eq('id', orderId).eq('customer_id', auth.customer.id).maybeSingle();
      if (order.error) return storefrontError('Order lookup unavailable', 503);
      if (!order.data) return storefrontError('Order not found', 404);
      const payment = await supabaseAdmin.from('commerce_payments' as never).select('*')
        .eq('order_id', orderId).eq('payment_channel', 'ordinary_wechat').maybeSingle();
      if (payment.error) return storefrontError('Payment lookup unavailable', 503);
      if (!payment.data) return storefrontJson({ ok: true, data: { order_id: orderId, status: 'no_ordinary_payment' } });
      try {
        const result = await reconcileOrdinaryPayment(ordinaryPaymentRuntime(), payment.data as OrdinaryPayment);
        return storefrontJson({ ok: true, data: { order_id: orderId, payment_id: result.id, status: result.status } });
      } catch { return storefrontError('支付结果确认中，请稍后重试', 503, 'payment_processing'); }
    },
  } },
});
