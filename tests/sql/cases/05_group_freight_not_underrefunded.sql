-- 反例：同组两条缺货都在兄弟仍待履约时取到 goods-only 报价。
-- 第一条确认成功后，第二条若仍用旧的 goods-only 版本确认，就会导致整组运费永久漏退。
-- 期望：第二条旧版本必须 QUOTE_CHANGED；刷新为含运费的新报价后确认成功；
--       整组运费恰好被退一次（合计 1000 分）。
DO $$
DECLARE
  ctx jsonb;
  s1 uuid; s2 uuid;
  cust uuid; ord uuid; loc uuid;
  ship_sum integer; intents integer;
  rejected boolean := false;
BEGIN
  -- 2 行，每行 100 元；运费 10 元；实付 210 元
  ctx := public.t_mk_order('under', 2, 100.00, 10.00, 210.00);
  cust := (ctx->>'customer_id')::uuid;
  ord := (ctx->>'order_id')::uuid;
  loc := (ctx->>'location_id')::uuid;

  UPDATE public.commerce_orders
     SET courier_quote_snapshot = jsonb_build_object(
           'groups', jsonb_build_array(
             jsonb_build_object('location_id', loc::text, 'shipping_fee_fen', 1000)))
   WHERE id = ord;

  -- 两条缺货都在对方仍待履约时报价 → 都是 goods-only
  s1 := public.t_mk_shortage(ctx, 0, 10000, 0, 'g1');
  s2 := public.t_mk_shortage(ctx, 1, 10000, 0, 'g2');

  PERFORM public.shortage_confirm_refund_v1(s1, cust, 'g1', 'k-under-1');

  -- 第二条：旧 goods-only 报价此时已过时（本次确认后该组再无待履约数量）
  BEGIN
    PERFORM public.shortage_confirm_refund_v1(s2, cust, 'g2', 'k-under-2');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%QUOTE_CHANGED%' THEN rejected := true; ELSE RAISE; END IF;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'FAIL 05: 过期的 goods-only 报价被接受，整组运费漏退';
  END IF;

  -- 客户重读：服务端按最新事实给出含运费的新版本
  PERFORM public.shortage_attach_quote_v1(
    s2, cust, ((ctx->'item_ids')->>1)::uuid, loc,
    jsonb_build_object('can_confirm', true, 'quote_version', 'g2b',
                       'refund_goods_fen', 10000, 'refund_shipping_fen', 1000,
                       'refund_total_fen', 11000));
  PERFORM public.shortage_confirm_refund_v1(s2, cust, 'g2b', 'k-under-2b');

  SELECT coalesce(sum(shipping_fen),0), count(*) INTO ship_sum, intents
    FROM public.commerce_refund_intents WHERE order_id = ord;

  IF ship_sum <> 1000 OR intents <> 2 THEN
    RAISE EXCEPTION 'FAIL 05: 运费合计 % 分（应为 1000），意图 % 条（应为 2）', ship_sum, intents;
  END IF;
  RAISE NOTICE 'PASS 05_group_freight_not_underrefunded (运费恰好退一次，合计 % 分)', ship_sum;
END $$;
