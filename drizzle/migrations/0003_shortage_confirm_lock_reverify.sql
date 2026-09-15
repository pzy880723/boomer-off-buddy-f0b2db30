CREATE OR REPLACE FUNCTION public.commerce_payment_reserved_fen(p_payment_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT sum(round(r.amount * 100))::integer
      FROM public.commerce_refunds r
     WHERE r.payment_id = p_payment_id AND r.status <> 'cancelled'
  ), 0)
  + coalesce((
    SELECT sum(i.amount_fen)::integer
      FROM public.commerce_refund_intents i
     WHERE i.payment_id = p_payment_id
       AND i.state <> 'failed'
       AND i.refund_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.commerce_refunds r2
          WHERE r2.payment_id = p_payment_id
            AND r2.status <> 'cancelled'
            AND r2.after_sale_id IS NOT NULL
            AND r2.after_sale_id = i.after_sale_id
       )
  ), 0);
$$;
REVOKE ALL ON FUNCTION public.commerce_payment_reserved_fen(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_payment_reserved_fen(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_order_item_reserved_fen(
  p_payment_id uuid,
  p_order_item_id uuid
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT sum(round(r.amount * 100))::integer
      FROM public.commerce_refunds r
      JOIN public.commerce_after_sales a ON a.id = r.after_sale_id
     WHERE r.payment_id = p_payment_id AND r.status <> 'cancelled'
       AND a.order_item_id = p_order_item_id
  ), 0)
  + coalesce((
    SELECT sum(i.amount_fen)::integer
      FROM public.commerce_refund_intents i
      JOIN public.commerce_after_sales a ON a.id = i.after_sale_id
     WHERE i.payment_id = p_payment_id
       AND i.state <> 'failed'
       AND i.refund_id IS NULL
       AND a.order_item_id = p_order_item_id
       AND NOT EXISTS (
         SELECT 1 FROM public.commerce_refunds r2
          WHERE r2.payment_id = p_payment_id
            AND r2.status <> 'cancelled'
            AND r2.after_sale_id = i.after_sale_id
       )
  ), 0);
$$;
REVOKE ALL ON FUNCTION public.commerce_order_item_reserved_fen(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_order_item_reserved_fen(uuid,uuid) TO service_role;

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

  SELECT * INTO v_item FROM public.commerce_order_items
   WHERE id = v_shortage.order_item_id AND order_id = v_order.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.fulfillments f
      JOIN public.shipments s ON s.fulfillment_id = f.id
     WHERE f.order_id = v_order.id
       AND f.location_id IS NOT DISTINCT FROM v_shortage.location_id
  ) INTO v_shipped;
  IF coalesce(v_shortage.refund_shipping_fen, 0) > 0 AND v_shipped THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;

  SELECT * INTO v_payment FROM public.commerce_payments
    WHERE order_id = v_order.id AND status = 'succeeded'
    ORDER BY paid_at DESC NULLS LAST, created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'paid_payment_not_found'; END IF;

  PERFORM 1 FROM public.commerce_payments WHERE id = v_payment.id FOR UPDATE;
  v_paid_fen := round(v_payment.amount * 100)::integer;
  v_reserved_fen := public.commerce_payment_reserved_fen(v_payment.id);

  SELECT coalesce(sum(s.quantity), 0)::integer INTO v_qty_other
    FROM public.fulfillment_shortages s
   WHERE s.order_item_id = v_shortage.order_item_id
     AND s.id <> v_shortage.id
     AND s.status <> 'rejected';
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