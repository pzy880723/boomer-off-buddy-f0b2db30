-- 同组运费只能退一次：两条缺货各自持有含运费的报价，支付余额足够两笔
-- 期望：第一条成功，第二条 QUOTE_CHANGED（必须重算成 goods-only 后才能确认）
DO $$
DECLARE
  ctx jsonb;
  s1 uuid; s2 uuid;
  err text;
  v_shipping_sum integer;
BEGIN
  ctx := public.t_mk_order('grp', 4, 100.00, 10.00, 410.00);
  s1 := public.t_mk_shortage(ctx, 0, 10000, 1000, 'v1');
  s2 := public.t_mk_shortage(ctx, 1, 10000, 1000, 'v1');

  PERFORM public.shortage_confirm_refund_v1(s1, (ctx->>'customer_id')::uuid, 'v1', 'idem-1');

  BEGIN
    PERFORM public.shortage_confirm_refund_v1(s2, (ctx->>'customer_id')::uuid, 'v1', 'idem-2');
    RAISE EXCEPTION 'FAIL: 第二条含运费缺货不应确认成功';
  EXCEPTION WHEN others THEN
    err := SQLERRM;
    IF err <> 'QUOTE_CHANGED' THEN RAISE EXCEPTION 'FAIL: 期望 QUOTE_CHANGED，实际 %', err; END IF;
  END;

  SELECT coalesce(sum(shipping_fen),0) INTO v_shipping_sum
    FROM public.commerce_refund_intents WHERE order_id = (ctx->>'order_id')::uuid;
  IF v_shipping_sum <> 1000 THEN RAISE EXCEPTION 'FAIL: 运费被退了 % 分', v_shipping_sum; END IF;
  RAISE NOTICE 'PASS 01_group_freight_once';
END;
$$;
