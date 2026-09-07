import { createFileRoute } from '@tanstack/react-router';
import { timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { ordinaryPaymentRuntime, ordinaryStore } from '@/server/ordinary-payment.server';
import { reconcileOrdinaryPayment, type OrdinaryPayment } from '@/server/ordinary-payment-flow';
import { reconcileOrdinaryRefund } from '@/server/ordinary-refund-flow';
import { runOrdinaryReconciliation } from '@/server/ordinary-reconciliation';

export const Route = createFileRoute('/api/internal/payments/reconcile')({ server: { handlers: {
  POST: async ({ request }) => {
    const expected = process.env.WECHAT_ORDINARY_RECONCILE_TOKEN?.trim();
    const supplied = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!expected || expected.length < 32) return Response.json({ error: 'Reconciliation not configured' }, { status: 503 });
    const left = Buffer.from(expected), right = Buffer.from(supplied);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return new Response(null, { status: 401 });
    try {
      const runtime = ordinaryPaymentRuntime();
      const result = await runOrdinaryReconciliation({
        async list() {
          const cutoff = new Date(Date.now() - 60_000).toISOString();
          const [payments, refunds] = await Promise.all([
            supabaseAdmin.from('commerce_payments' as never).select('*').eq('payment_channel', 'ordinary_wechat')
              .in('status', ['pending', 'processing']).or(`ordinary_checked_at.is.null,ordinary_checked_at.lt.${cutoff}`)
              .order('ordinary_checked_at', { nullsFirst: true }).limit(20),
            supabaseAdmin.from('commerce_refunds' as never).select('id,merchant_refund_no').not('merchant_refund_no', 'is', null)
              .in('status', ['pending', 'processing', 'failed']).or(`ordinary_checked_at.is.null,ordinary_checked_at.lt.${cutoff}`)
              .order('ordinary_checked_at', { nullsFirst: true }).limit(20),
          ]);
          if (payments.error || refunds.error) throw new Error('Reconciliation ledger unavailable');
          return [
            ...((payments.data ?? []) as OrdinaryPayment[]).map(payment => ({ id: payment.id, kind: 'payment', payment, refundNo: '' })),
            ...((refunds.data ?? []) as Array<{ id: string; merchant_refund_no: string }>).map(refund => ({
              id: refund.id, kind: 'refund', payment: null, refundNo: refund.merchant_refund_no,
            })),
          ];
        },
        async reconcile(item) {
          if (item.payment) return reconcileOrdinaryPayment(runtime, item.payment);
          const found = await ordinaryStore.findRefund(item.refundNo);
          if (!found) throw new Error('Refund not found');
          return reconcileOrdinaryRefund(runtime, found.refund as typeof found.refund & { status: string }, found.payment);
        },
        async markChecked(item) {
          const result = await supabaseAdmin.from((item.kind === 'payment' ? 'commerce_payments' : 'commerce_refunds') as never)
            .update({ ordinary_checked_at: new Date().toISOString() } as never).eq('id', item.id);
          if (result.error) throw new Error('Reconciliation checkpoint failed');
        },
      });
      return Response.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 503 : 200 });
    } catch { return Response.json({ ok: false, error: 'Reconciliation unavailable' }, { status: 503 }); }
  },
} } });
