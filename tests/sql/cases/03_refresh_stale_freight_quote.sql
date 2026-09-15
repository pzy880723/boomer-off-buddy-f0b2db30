-- 发货后含运费的旧报价必须可被安全刷新为 goods-only（不能永久 409）
DO $$
DECLARE
  ctx jsonb;
  s1 uuid;
  res jsonb;
  row public.fulfillment_shortages%ROWTYPE;
  err text;
BEGIN
  ctx := public.t_mk_order('stale', 2, 100.00, 10.00, 210.00);
  s1 := public.t_mk_shortage(ctx, 0, 10000, 1000, 'v1');

  -- 该门店组已发货 → 运费不再可退
  INSERT INTO public.shipments (fulfillment_id, provider, service_code, idempotency_key, status)
    VALUES ((ctx->>'fulfillment_id')::uuid, 'sf', 'std', 'ship-stale', 'booked');

  -- 旧版本确认必须被拒
  BEGIN
    PERFORM public.shortage_confirm_refund_v1(s1, (ctx->>'customer_id')::uuid, 'v1', 'idem-stale-1');
    RAISE EXCEPTION 'FAIL: 发货后含运费报价不应确认成功';
  EXCEPTION WHEN others THEN
    err := SQLERRM;
    IF err <> 'QUOTE_CHANGED' THEN RAISE EXCEPTION 'FAIL: 期望 QUOTE_CHANGED，实际 %', err; END IF;
  END;

  -- 刷新为 goods-only
  res := public.shortage_attach_quote_v1(s1, (ctx->>'customer_id')::uuid, NULL, NULL,
    jsonb_build_object('can_confirm', true, 'quote_version', 'v2',
                       'refund_goods_fen', 10000, 'refund_shipping_fen', 0, 'refund_total_fen', 10000));
  IF (res->>'changed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: 旧报价未被刷新'; END IF;

  SELECT * INTO row FROM public.fulfillment_shortages WHERE id = s1;
  IF row.quote_version <> 'v2' OR coalesce(row.refund_shipping_fen,0) <> 0 THEN
    RAISE EXCEPTION 'FAIL: 刷新后仍为 % / %', row.quote_version, row.refund_shipping_fen;
  END IF;

  PERFORM public.shortage_confirm_refund_v1(s1, (ctx->>'customer_id')::uuid, 'v2', 'idem-stale-2');
  SELECT * INTO row FROM public.fulfillment_shortages WHERE id = s1;
  IF row.refund_intent_id IS NULL THEN RAISE EXCEPTION 'FAIL: 新版本确认未生成退款意图'; END IF;
  RAISE NOTICE 'PASS 03_refresh_stale_freight_quote';
END;
$$;
