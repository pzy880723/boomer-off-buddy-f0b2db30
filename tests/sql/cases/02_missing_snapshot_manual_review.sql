-- 缺运费快照（can_confirm=false）报缺货：必须落 manual_review + 金额 0 + 无 quote_version，
-- 且客户确认必须被拒绝，不得因为 refund_state 被误写成 awaiting_confirmation 而放行。
DO $$
DECLARE
  ctx jsonb;
  res jsonb;
  row public.fulfillment_shortages%ROWTYPE;
  err text;
BEGIN
  ctx := public.t_mk_order('nosnap', 1, 100.00, 10.00, 110.00);
  res := public.shortage_report_v1(
    (ctx->>'fulfillment_id')::uuid,
    ((ctx->'fulfillment_item_ids')->>0)::uuid,
    1, '缺货', 'op-nosnap', NULL, NULL,
    jsonb_build_object('can_confirm', false,
                       'blocked_reasons', jsonb_build_array('missing_shipping_snapshot'),
                       'refund_goods_fen', 10000, 'refund_shipping_fen', 0,
                       'refund_total_fen', 10000, 'quote_version', 'v1'));

  SELECT * INTO row FROM public.fulfillment_shortages WHERE id = ((res->'shortage')->>'id')::uuid;
  IF row.refund_state <> 'manual_review' THEN RAISE EXCEPTION 'FAIL: refund_state=%', row.refund_state; END IF;
  IF coalesce(row.refund_total_fen, 0) <> 0 THEN RAISE EXCEPTION 'FAIL: 金额被编造 %', row.refund_total_fen; END IF;
  IF row.quote_version IS NOT NULL THEN RAISE EXCEPTION 'FAIL: 不应有 quote_version'; END IF;

  BEGIN
    PERFORM public.shortage_confirm_refund_v1(row.id, (ctx->>'customer_id')::uuid, 'v1', 'idem-nosnap');
    RAISE EXCEPTION 'FAIL: 无效报价不应可确认';
  EXCEPTION WHEN others THEN
    err := SQLERRM;
    IF err NOT IN ('QUOTE_CHANGED', 'not_confirmable', 'no_refundable_amount') THEN
      RAISE EXCEPTION 'FAIL: 意外错误 %', err;
    END IF;
  END;
  RAISE NOTICE 'PASS 02_missing_snapshot_manual_review';
END;
$$;
