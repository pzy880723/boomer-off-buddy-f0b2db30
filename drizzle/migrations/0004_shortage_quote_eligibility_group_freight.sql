-- 缺货退款发布阻断修正 v1
-- 1) shortage_report_v1 必须尊重报价的 can_confirm/blocked_reasons，缺快照不得写成 awaiting_confirmation
-- 2) shortage_attach_quote_v1 允许在无退款意图时安全刷新旧的正数报价（发货后重算为 goods-only）
-- 3) shortage_confirm_refund_v1：先锁支付再复核；同组运费只允许被退一次；支持合法连续部分退款

CREATE OR REPLACE FUNCTION public.shortage_report_v1(
  p_fulfillment_id uuid,
  p_fulfillment_item_id uuid,
  p_quantity integer,
  p_reason text,
  p_client_op_id text,
  p_reported_by uuid,
  p_device_id uuid,
  p_quote jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.fulfillment_items%ROWTYPE;
  v_fulfillment public.fulfillments%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_declared integer;
  v_available integer;
  v_shortage public.fulfillment_shortages%ROWTYPE;
  v_customer_id uuid;
  v_phone text;
  v_title text;
  v_total integer;
  v_ok boolean;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_client_op_id IS NULL OR length(p_client_op_id) = 0 THEN RAISE EXCEPTION 'client_op_id_required'; END IF;

  SELECT * INTO v_shortage FROM public.fulfillment_shortages
    WHERE fulfillment_id = p_fulfillment_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'replayed', true);
  END IF;

  SELECT * INTO v_item FROM public.fulfillment_items
    WHERE id = p_fulfillment_item_id AND fulfillment_id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'line_mismatch'; END IF;

  SELECT * INTO v_fulfillment FROM public.fulfillments WHERE id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_not_found'; END IF;

  SELECT coalesce(sum(quantity), 0) INTO v_declared FROM public.fulfillment_shortages
    WHERE fulfillment_item_id = p_fulfillment_item_id AND status <> 'withdrawn';

  v_available := coalesce(v_item.expected_qty, 0) - coalesce(v_item.picked_qty, 0) - v_declared;
  IF v_available <= 0 THEN RAISE EXCEPTION 'no_declarable_quantity'; END IF;
  IF p_quantity > v_available THEN RAISE EXCEPTION 'quantity_exceeds_declarable'; END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_fulfillment.order_id;

  -- 报价资格由计算器决定：can_confirm=false（如缺运费快照）一律落人工复核 + 金额 0
  v_total := coalesce(nullif(p_quote->>'refund_total_fen','')::integer, 0);
  v_ok := coalesce((p_quote->>'can_confirm')::boolean, false) AND v_total > 0;

  INSERT INTO public.fulfillment_shortages (
    fulfillment_id, fulfillment_item_id, order_id, order_item_id, location_id,
    quantity, reason, status, refund_state, reported_by, device_id, client_op_id,
    product_name, image_ref, quote_version, refund_goods_fen, refund_shipping_fen,
    refund_total_fen, quote_snapshot
  ) VALUES (
    p_fulfillment_id, p_fulfillment_item_id, v_fulfillment.order_id, v_item.order_item_id,
    v_fulfillment.location_id, p_quantity, p_reason, 'pending_customer',
    CASE WHEN v_ok THEN 'awaiting_confirmation' ELSE 'manual_review' END,
    p_reported_by, p_device_id, p_client_op_id,
    nullif(p_quote->>'product_name',''), nullif(p_quote->>'image_ref',''),
    CASE WHEN v_ok THEN nullif(p_quote->>'quote_version','') ELSE NULL END,
    CASE WHEN v_ok THEN nullif(p_quote->>'refund_goods_fen','')::integer ELSE 0 END,
    CASE WHEN v_ok THEN nullif(p_quote->>'refund_shipping_fen','')::integer ELSE 0 END,
    CASE WHEN v_ok THEN v_total ELSE 0 END,
    p_quote
  ) RETURNING * INTO v_shortage;

  v_customer_id := v_order.customer_id;
  v_title := '订单商品缺货，请确认退款';

  IF v_customer_id IS NOT NULL THEN
    INSERT INTO public.commerce_customer_notifications (
      customer_id, kind, title, body, shortage_id, order_id, dedupe_key
    ) VALUES (
      v_customer_id, 'shortage', v_title,
      format('订单 %s 中「%s」缺货 %s 件，请在订单售后中确认退款金额。',
             coalesce(v_order.order_no,''), coalesce(nullif(p_quote->>'product_name',''),'商品'), p_quantity),
      v_shortage.id, v_order.id, 'shortage:' || v_shortage.id || ':reported'
    ) ON CONFLICT DO NOTHING;

    SELECT phone INTO v_phone FROM public.commerce_customers WHERE id = v_customer_id;
    IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
      INSERT INTO public.commerce_sms_outbox (
        template_key, phone, params, shortage_id, order_id, customer_id, dedupe_key
      ) VALUES (
        'shortage_reported', v_phone,
        jsonb_build_array(coalesce(v_order.order_no,''), p_quantity::text),
        v_shortage.id, v_order.id, v_customer_id, 'shortage:' || v_shortage.id || ':reported'
      ) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'replayed', false,
                            'declarable_before', v_available);
END;
$$;
REVOKE ALL ON FUNCTION public.shortage_report_v1(uuid,uuid,integer,text,text,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shortage_report_v1(uuid,uuid,integer,text,text,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.shortage_attach_quote_v1(
  p_shortage_id uuid,
  p_customer_id uuid,
  p_order_item_id uuid,
  p_location_id uuid,
  p_quote jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shortage public.fulfillment_shortages%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_total integer;
  v_ok boolean;
BEGIN
  SELECT * INTO v_shortage FROM public.fulfillment_shortages WHERE id = p_shortage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_shortage.order_id;
  IF NOT FOUND OR v_order.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- 已有退款意图或客户已表态 → 一律不改写报价（金额已被意图锁定）
  IF v_shortage.refund_intent_id IS NOT NULL OR v_shortage.status <> 'pending_customer' THEN
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'changed', false);
  END IF;

  -- 仍待客户确认且无意图 → 允许按最新事实刷新（含把发货后的含运费旧报价改成 goods-only）。
  -- 版本随之改变，客户端用旧版本确认会拿到 QUOTE_CHANGED 并重读新版本，不会永久卡死。
  v_total := coalesce(nullif(p_quote->>'refund_total_fen','')::integer, 0);
  v_ok := coalesce((p_quote->>'can_confirm')::boolean, false) AND v_total > 0;

  UPDATE public.fulfillment_shortages SET
    order_item_id = coalesce(order_item_id, p_order_item_id),
    location_id = coalesce(location_id, p_location_id),
    product_name = coalesce(product_name, nullif(p_quote->>'product_name','')),
    image_ref = coalesce(image_ref, nullif(p_quote->>'image_ref','')),
    quote_version = CASE WHEN v_ok THEN nullif(p_quote->>'quote_version','') ELSE NULL END,
    refund_goods_fen = CASE WHEN v_ok THEN nullif(p_quote->>'refund_goods_fen','')::integer ELSE 0 END,
    refund_shipping_fen = CASE WHEN v_ok THEN nullif(p_quote->>'refund_shipping_fen','')::integer ELSE 0 END,
    refund_total_fen = CASE WHEN v_ok THEN v_total ELSE 0 END,
    quote_snapshot = p_quote,
    refund_state = CASE WHEN v_ok THEN 'awaiting_confirmation' ELSE 'manual_review' END,
    updated_at = now()
  WHERE id = p_shortage_id
  RETURNING * INTO v_shortage;

  RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.shortage_attach_quote_v1(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shortage_attach_quote_v1(uuid,uuid,uuid,uuid,jsonb) TO service_role;

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