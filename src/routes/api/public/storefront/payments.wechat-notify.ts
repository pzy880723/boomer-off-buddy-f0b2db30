import { createFileRoute } from '@tanstack/react-router';
import { ordinaryPaymentRuntime, readNotificationBody } from '@/server/ordinary-payment.server';
import { applyOrdinaryNotification } from '@/server/ordinary-payment-notifications';

export const Route = createFileRoute('/api/public/storefront/payments/wechat-notify')({
  server: { handlers: { POST: async ({ request }) => {
    try {
      const runtime = ordinaryPaymentRuntime();
      const event = runtime.client.decodeNotification(await readNotificationBody(request), request.headers);
      await applyOrdinaryNotification(runtime.store, event);
      return new Response(null, { status: 204 });
    } catch {
      // Never acknowledge a notification before the transaction commits, or
      // leak decrypted customer details/signature inputs into public responses.
      return Response.json({ code: 'FAIL', message: 'Notification not accepted' }, { status: 503 });
    }
  } } },
});
