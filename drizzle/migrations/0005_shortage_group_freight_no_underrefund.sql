-- 缺货退款 P1：同组运费漏退修正
-- 场景：同组两条缺货都在兄弟仍待履约时取到 goods-only 报价；第一条确认后，
-- 第二条仍用旧的 goods-only 版本确认，0004 只校验「原报价含运费」的过期情形，
-- 于是两次都不退运费，整组运费永久漏退。
-- 修正：确认事务在支付/订单行锁内重新核验「该组是否仍应退运费」，
-- goods-only 已过时即 QUOTE_CHANGED，客户重读新版本后确认，整组运费恰好退一次。

CREATE OR REPLACE FUNCTION public.shortage_confirm_refund_v1(
  p_shortage_id uuid,
  p_customer_id uuid,
  p_quote_version text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shortage public.fulfillment_shortages%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_payment public.commerce_payments%ROWTYPE;
  v_intent public.commerce_refund_intents%ROWTYPE;
  v_after_sale public.commerce_after_sales%ROWTYPE;
  v_item public.commerce_order_items%ROWTYPE;
  v_reserved_fen integer;
  v_paid_fen integer;
  v_line_sum numeric;
  v_item_cap_fen integer;
  v_item_reserved_fen integer;
  v_qty_other integer;
  v_shipped boolean;
  v_group_shipping_taken boolean;
  v_group_fee_fen integer;
  v_group_outstanding integer;
  v_snapshot_valid boolean;
BEGIN
  SELECT * INTO v_shortage FROM public.fulfillment_shortages WHERE id = p_shortage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_shortage.order_id;
  IF NOT FOUND OR v_order.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_refund_intents WHERE shortage_id = p_shortage_id;
  IF FOUND THEN
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'intent', to_jsonb(v_intent), 'replayed', true);
  END IF;

  IF v_shortage.status <> 'pending_customer' THEN RAISE EXCEPTION 'not_confirmable'; END IF;
  IF v_shortage.quote_version IS NULL OR v_shortage.quote_version IS DISTINCT FROM p_quote_version THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;
  IF coalesce(v_shortage.refund_total_fen, 0) <= 0 THEN RAISE EXCEPTION 'no_refundable_amount'; END IF;
  IF v_shortage.refund_state <> 'awaiting_confirmation' THEN RAISE EXCEPTION 'not_confirmable'; END IF;
  IF v_shortage.order_item_id IS NULL THEN RAISE EXCEPTION 'no_refundable_amount'; END IF;
  -- 落库时的报价资格必须为真（缺快照等情况绝不放行）
  IF v_shortage.quote_snapshot IS NOT NULL
     AND coalesce((v_shortage.quote_snapshot->>'can_confirm')::boolean, true) = false THEN
    RAISE EXCEPTION 'not_confirmable';
  END IF;

  SELECT * INTO v_item FROM public.commerce_order_items
   WHERE id = v_shortage.order_item_id AND order_id = v_order.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  -- 支付行锁：客户退款与总部退款、以及同一支付下的其它缺货确认在此串行化
  SELECT * INTO v_payment FROM public.commerce_payments
    WHERE order_id = v_order.id AND status IN ('succeeded','partially_refunded')
    ORDER BY paid_at DESC NULLS LAST, created_at DESC LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.commerce_payments WHERE order_id = v_order.id AND status = 'refunded') THEN
      RAISE EXCEPTION 'payment_fully_refunded';
    END IF;
    RAISE EXCEPTION 'paid_payment_not_found';
  END IF;

  -- 锁内重读该缺货，避免刚被别的事务改写报价/状态
  SELECT * INTO v_shortage FROM public.fulfillment_shortages WHERE id = p_shortage_id;
  IF v_shortage.quote_version IS DISTINCT FROM p_quote_version
     OR v_shortage.status <> 'pending_customer'
     OR v_shortage.refund_state <> 'awaiting_confirmation' THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.fulfillments f
      JOIN public.shipments s ON s.fulfillment_id = f.id
     WHERE f.order_id = v_order.id
       AND f.location_id IS NOT DISTINCT FROM v_shortage.location_id
  ) INTO v_shipped;
  IF coalesce(v_shortage.refund_shipping_fen, 0) > 0 AND v_shipped THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;

  -- 同组运费只能被退一次：已有其它缺货把该组运费预留/退掉 → 必须重算成 goods-only 再确认
  SELECT EXISTS (
    SELECT 1 FROM public.fulfillment_shortages s2
     WHERE s2.order_id = v_order.id
       AND s2.id <> v_shortage.id
       AND s2.location_id IS NOT DISTINCT FROM v_shortage.location_id
       AND s2.status NOT IN ('withdrawn','customer_cancelled')
       AND coalesce(s2.refund_shipping_fen, 0) > 0
       AND s2.refund_intent_id IS NOT NULL
  ) INTO v_group_shipping_taken;
  IF coalesce(v_shortage.refund_shipping_fen, 0) > 0 AND v_group_shipping_taken THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;

  -- 漏退运费防线：本次报价是 goods-only，但按事务锁内的最新事实，该组运费现在
  -- 应当随本次一起退（组未发货、无其它缺货占用该组运费、且本次确认后该组已无任何
  -- 待履约数量）→ 旧报价已过时，必须 QUOTE_CHANGED，由客户重读含运费的新版本再确认。
  -- 这样整组运费恰好被退一次，既不重复也不漏退。
  IF coalesce(v_shortage.refund_shipping_fen, 0) = 0
     AND NOT v_shipped AND NOT v_group_shipping_taken THEN
    -- 运费快照必须整体可映射（与 TS parseShippingGroups 同口径），否则不做任何推断
    SELECT jsonb_typeof(v_order.courier_quote_snapshot->'groups') = 'array'
           AND jsonb_array_length(coalesce(v_order.courier_quote_snapshot->'groups','[]'::jsonb)) > 0
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(coalesce(v_order.courier_quote_snapshot->'groups','[]'::jsonb)) g
              WHERE nullif(g->>'location_id','') IS NULL
                 OR jsonb_typeof(g->'shipping_fee_fen') <> 'number'
                 OR (g->>'shipping_fee_fen') !~ '^[0-9]+$'
           )
      INTO v_snapshot_valid;

    IF coalesce(v_snapshot_valid, false) THEN
      SELECT coalesce(max((g->>'shipping_fee_fen')::integer), 0) INTO v_group_fee_fen
        FROM jsonb_array_elements(v_order.courier_quote_snapshot->'groups') g
       WHERE nullif(g->>'location_id','')::uuid IS NOT DISTINCT FROM v_shortage.location_id;

      IF coalesce(v_group_fee_fen, 0) > 0 THEN
        SELECT coalesce(sum(
                 greatest(oi.quantity - coalesce((
                   SELECT sum(s3.quantity) FROM public.fulfillment_shortages s3
                    WHERE s3.order_item_id = oi.id
                      AND s3.id <> v_shortage.id
                      AND s3.status NOT IN ('withdrawn','customer_cancelled')
                      AND (s3.refund_intent_id IS NOT NULL
                           OR s3.status = 'customer_accepted'
                           OR s3.refund_state IN ('queued','processing','succeeded','refund_pending','refund_completed'))
                 ), 0), 0)
               ), 0)::integer INTO v_group_outstanding
          FROM public.commerce_order_items oi
         WHERE oi.order_id = v_order.id
           AND oi.location_id IS NOT DISTINCT FROM v_shortage.location_id;

        IF v_group_outstanding - v_shortage.quantity <= 0 THEN
          RAISE EXCEPTION 'QUOTE_CHANGED';
        END IF;
      END IF;
    END IF;
  END IF;

  v_paid_fen := round(v_payment.amount * 100)::integer;
  v_reserved_fen := public.commerce_payment_reserved_fen(v_payment.id);

  SELECT coalesce(sum(s.quantity), 0)::integer INTO v_qty_other
    FROM public.fulfillment_shortages s
   WHERE s.order_item_id = v_shortage.order_item_id
     AND s.id <> v_shortage.id
     AND s.status NOT IN ('withdrawn','customer_cancelled');
  IF v_qty_other + v_shortage.quantity > v_item.quantity THEN
    UPDATE public.fulfillment_shortages SET refund_state = 'manual_review', updated_at = now()
      WHERE id = v_shortage.id RETURNING * INTO v_shortage;
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'intent', NULL,
                              'replayed', false, 'manual_review', true);
  END IF;

  SELECT coalesce(sum(line_total), 0) INTO v_line_sum
    FROM public.commerce_order_items WHERE order_id = v_order.id;
  IF v_line_sum > 0 THEN
    v_item_cap_fen := ceil(
      (v_paid_fen - round(coalesce(v_order.shipping_fee, 0) * 100))::numeric
      * v_item.line_total / v_line_sum
    )::integer + round(coalesce(v_shortage.refund_shipping_fen, 0))::integer;
  ELSE
    v_item_cap_fen := v_paid_fen;
  END IF;
  v_item_reserved_fen := public.commerce_order_item_reserved_fen(v_payment.id, v_shortage.order_item_id);

  IF v_shortage.refund_total_fen > v_paid_fen - v_reserved_fen
     OR v_shortage.refund_total_fen > v_item_cap_fen - v_item_reserved_fen THEN
    UPDATE public.fulfillment_shortages
      SET refund_state = 'manual_review', updated_at = now()
      WHERE id = v_shortage.id RETURNING * INTO v_shortage;
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'intent', NULL,
                              'replayed', false, 'manual_review', true);
  END IF;

  INSERT INTO public.commerce_after_sales (
    after_sale_no, order_id, order_item_id, location_id, user_id, type, status,
    reason_code, reason_text, requested_amount, approved_amount, requested_at, refund_requested_at
  ) VALUES (
    public.gen_commerce_after_sale_no(), v_order.id, v_shortage.order_item_id,
    v_shortage.location_id, coalesce(v_order.user_id, v_order.customer_id),
    'refund_only', 'refund_pending', 'stock_shortage', v_shortage.reason,
    round(v_shortage.refund_total_fen::numeric / 100, 2),
    round(v_shortage.refund_total_fen::numeric / 100, 2),
    now(), now()
  ) RETURNING * INTO v_after_sale;

  INSERT INTO public.commerce_refund_intents (
    shortage_id, order_id, customer_id, payment_id, after_sale_id,
    amount_fen, goods_fen, shipping_fen, quote_version, idempotency_key, state
  ) VALUES (
    v_shortage.id, v_order.id, p_customer_id, v_payment.id, v_after_sale.id,
    v_shortage.refund_total_fen, coalesce(v_shortage.refund_goods_fen,0),
    coalesce(v_shortage.refund_shipping_fen,0), p_quote_version, p_idempotency_key, 'queued'
  ) RETURNING * INTO v_intent;

  UPDATE public.fulfillment_shortages SET
    status = 'customer_accepted',
    refund_state = 'queued',
    after_sale_id = v_after_sale.id,
    refund_intent_id = v_intent.id,
    customer_responded_at = coalesce(customer_responded_at, now()),
    refund_requested_at = now(),
    updated_at = now()
  WHERE id = v_shortage.id RETURNING * INTO v_shortage;

  INSERT INTO public.commerce_customer_notifications (
    customer_id, kind, title, body, shortage_id, order_id, dedupe_key
  ) VALUES (
    p_customer_id, 'refund', '退款已受理',
    format('订单 %s 的缺货退款 %s 元已受理，将按原支付方式退回。',
           coalesce(v_order.order_no,''), round(v_shortage.refund_total_fen::numeric/100, 2)),
    v_shortage.id, v_order.id, 'shortage:' || v_shortage.id || ':refund_queued'
  ) ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'intent', to_jsonb(v_intent), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.shortage_confirm_refund_v1(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shortage_confirm_refund_v1(uuid,uuid,text,text) TO service_role;