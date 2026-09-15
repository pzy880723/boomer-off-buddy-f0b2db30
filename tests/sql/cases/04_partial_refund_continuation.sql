-- 合法的连续部分退款：支付被置为 partially_refunded 后仍可继续退；已全退则拒绝。
DO $$
DECLARE
  ctx jsonb;
  s1 uuid; s2 uuid;
  row public.fulfillment_shortages%ROWTYPE;
  err text;
BEGIN
  ctx := public.t_mk_order('part', 4, 100.00, 0.00, 400.00);
  s1 := public.t_mk_shortage(ctx, 0, 10000, 0, 'v1');
  s2 := public.t_mk_shortage(ctx, 1, 10000, 0, 'v1');

  PERFORM public.shortage_confirm_refund_v1(s1, (ctx->>'customer_id')::uuid, 'v1', 'idem-p1');

  -- 模拟第一笔已真实退款完成：意图落 refund 行，支付变 partially_refunded
  INSERT INTO public.commerce_refunds (order_id, payment_id, provider, amount, status,
                                       idempotency_key, after_sale_id)
    SELECT (ctx->>'order_id')::uuid, (ctx->>'payment_id')::uuid, 'wechat', 100.00, 'succeeded',
           'refund-p1', i.after_sale_id
      FROM public.commerce_refund_intents i WHERE i.shortage_id = s1;
  UPDATE public.commerce_refund_intents SET state = 'succeeded',
         refund_id = (SELECT id FROM public.commerce_refunds WHERE idempotency_key = 'refund-p1')
   WHERE shortage_id = s1;
  UPDATE public.commerce_payments SET status = 'partially_refunded' WHERE id = (ctx->>'payment_id')::uuid;

  PERFORM public.shortage_confirm_refund_v1(s2, (ctx->>'customer_id')::uuid, 'v1', 'idem-p2');
  SELECT * INTO row FROM public.fulfillment_shortages WHERE id = s2;
  IF row.refund_intent_id IS NULL THEN RAISE EXCEPTION 'FAIL: 部分退款后第二笔被错误阻断'; END IF;

  -- 已全额退款的支付：不得再退
  UPDATE public.commerce_payments SET status = 'refunded' WHERE id = (ctx->>'payment_id')::uuid;
  DECLARE s3 uuid := public.t_mk_shortage(ctx, 2, 10000, 0, 'v1');
  BEGIN
    BEGIN
      PERFORM public.shortage_confirm_refund_v1(s3, (ctx->>'customer_id')::uuid, 'v1', 'idem-p3');
      RAISE EXCEPTION 'FAIL: 已全退支付不应再退';
    EXCEPTION WHEN others THEN
      err := SQLERRM;
      IF err <> 'payment_fully_refunded' THEN RAISE EXCEPTION 'FAIL: 期望 payment_fully_refunded，实际 %', err; END IF;
    END;
  END;
  RAISE NOTICE 'PASS 04_partial_refund_continuation';
END;
$$;
