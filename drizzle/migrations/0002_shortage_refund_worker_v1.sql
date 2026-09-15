-- 退款执行 worker 租约 + 旧缺货报价补齐 + 确认时锁内金额复核（全部增量）

-- 1) 旧缺货：按服务端重新核算的报价落库，使其可被客户正常确认。
--    无法安全报价（can_confirm=false 或金额<=0）→ manual_review + 金额 0 + 无 quote_version，不编造金额。
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

  -- 已有退款意图或客户已表态 → 一律不改写报价
  IF v_shortage.refund_intent_id IS NOT NULL OR v_shortage.status <> 'pending_customer' THEN
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'changed', false);
  END IF;
  IF v_shortage.quote_version IS NOT NULL AND coalesce(v_shortage.refund_total_fen, 0) > 0
     AND v_shortage.refund_state = 'awaiting_confirmation' THEN
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'changed', false);
  END IF;

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

-- 2) 客户确认：在锁内复核支付级「已退 + 预占」上限，超限不生成意图，转人工。
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
  v_reserved_fen integer;
  v_paid_fen integer;
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

  IF v_shortage.quote_version IS NULL OR v_shortage.quote_version IS DISTINCT FROM p_quote_version THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;
  IF coalesce(v_shortage.refund_total_fen, 0) <= 0 THEN RAISE EXCEPTION 'no_refundable_amount'; END IF;
  IF v_shortage.refund_state <> 'awaiting_confirmation' THEN RAISE EXCEPTION 'not_confirmable'; END IF;

  SELECT * INTO v_payment FROM public.commerce_payments
    WHERE order_id = v_order.id AND status = 'succeeded'
    ORDER BY paid_at DESC NULLS LAST, created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'paid_payment_not_found'; END IF;

  -- 锁内复核：真实收款额 - （已退 + 其他在途意图预占）
  PERFORM 1 FROM public.commerce_payments WHERE id = v_payment.id FOR UPDATE;
  v_paid_fen := round(v_payment.amount * 100)::integer;
  SELECT coalesce(sum(round(r.amount * 100)), 0)::integer INTO v_reserved_fen
    FROM public.commerce_refunds r WHERE r.payment_id = v_payment.id AND r.status <> 'cancelled';
  SELECT v_reserved_fen + coalesce(sum(i.amount_fen), 0)::integer INTO v_reserved_fen
    FROM public.commerce_refund_intents i WHERE i.payment_id = v_payment.id AND i.state <> 'failed';

  IF v_shortage.refund_total_fen > v_paid_fen - v_reserved_fen THEN
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

-- 3) worker 批量认领（租约 + SKIP LOCKED，重复 worker 不会并发处理同一意图）
CREATE OR REPLACE FUNCTION public.commerce_claim_refund_intents(
  p_limit integer,
  p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows jsonb;
BEGIN
  WITH candidate AS (
    SELECT id FROM public.commerce_refund_intents
      WHERE state IN ('queued','processing')
        AND next_attempt_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY next_attempt_at
      LIMIT greatest(coalesce(p_limit,1), 1)
      FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.commerce_refund_intents i
      SET state = 'processing',
          attempts = i.attempts + 1,
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds,120), 30)),
          updated_at = now()
      FROM candidate c WHERE i.id = c.id
      RETURNING i.*
  )
  SELECT coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) INTO v_rows FROM claimed;
  RETURN v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_claim_refund_intents(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_refund_intents(integer,integer) TO service_role;

-- 4) 单笔认领（客户确认后立即尝试；认领不到即交给后台补偿）
CREATE OR REPLACE FUNCTION public.commerce_claim_refund_intent(
  p_intent_id uuid,
  p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_intent public.commerce_refund_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.commerce_refund_intents
    WHERE id = p_intent_id AND state IN ('queued','processing')
      AND (lease_expires_at IS NULL OR lease_expires_at < now())
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  UPDATE public.commerce_refund_intents SET
    state = 'processing',
    attempts = attempts + 1,
    lease_token = gen_random_uuid(),
    lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds,120), 30)),
    updated_at = now()
  WHERE id = p_intent_id RETURNING * INTO v_intent;

  RETURN jsonb_build_array(to_jsonb(v_intent));
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_claim_refund_intent(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_claim_refund_intent(uuid,integer) TO service_role;

-- 5) 结算：校验租约，同事务同步缺货 / 售后 / 客户通知
CREATE OR REPLACE FUNCTION public.commerce_settle_refund_intent(
  p_intent_id uuid,
  p_lease_token uuid,
  p_state text,
  p_error text,
  p_refund_id uuid,
  p_retry_delay_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent public.commerce_refund_intents%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
BEGIN
  IF p_state NOT IN ('queued','processing','succeeded','failed','manual_review') THEN
    RAISE EXCEPTION 'invalid_state';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_refund_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_intent.state = 'succeeded' THEN
    RETURN jsonb_build_object('intent', to_jsonb(v_intent), 'replayed', true);
  END IF;
  IF v_intent.lease_token IS DISTINCT FROM p_lease_token THEN RAISE EXCEPTION 'lease_lost'; END IF;

  UPDATE public.commerce_refund_intents SET
    state = p_state,
    last_error = p_error,
    refund_id = coalesce(p_refund_id, refund_id),
    lease_token = NULL,
    lease_expires_at = NULL,
    next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_delay_seconds,0), 0)),
    succeeded_at = CASE WHEN p_state = 'succeeded' THEN now() ELSE succeeded_at END,
    updated_at = now()
  WHERE id = p_intent_id RETURNING * INTO v_intent;

  UPDATE public.fulfillment_shortages SET
    refund_state = p_state,
    refunded_at = CASE WHEN p_state = 'succeeded' THEN now() ELSE refunded_at END,
    updated_at = now()
  WHERE id = v_intent.shortage_id;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_intent.order_id;

  IF p_state = 'succeeded' THEN
    UPDATE public.commerce_after_sales SET status = 'refunded', refunded_at = now(), updated_at = now()
      WHERE id = v_intent.after_sale_id AND status <> 'refunded';
    INSERT INTO public.commerce_customer_notifications (
      customer_id, kind, title, body, shortage_id, order_id, dedupe_key
    ) VALUES (
      v_intent.customer_id, 'refund', '退款已原路退回',
      format('订单 %s 的缺货退款 %s 元已按原支付方式退回。',
             coalesce(v_order.order_no,''), round(v_intent.amount_fen::numeric/100, 2)),
      v_intent.shortage_id, v_intent.order_id, 'shortage:' || v_intent.shortage_id || ':refund_succeeded'
    ) ON CONFLICT DO NOTHING;
  ELSIF p_state IN ('failed','manual_review') THEN
    INSERT INTO public.commerce_customer_notifications (
      customer_id, kind, title, body, shortage_id, order_id, dedupe_key
    ) VALUES (
      v_intent.customer_id, 'refund', '退款处理中，需人工核实',
      format('订单 %s 的缺货退款正在人工核实，客服会尽快与你联系。', coalesce(v_order.order_no,'')),
      v_intent.shortage_id, v_intent.order_id,
      'shortage:' || v_intent.shortage_id || ':refund_' || p_state
    ) ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('intent', to_jsonb(v_intent), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_settle_refund_intent(uuid,uuid,text,text,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_settle_refund_intent(uuid,uuid,text,text,uuid,integer) TO service_role;