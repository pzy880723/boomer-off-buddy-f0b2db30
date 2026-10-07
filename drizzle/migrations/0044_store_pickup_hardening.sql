-- 自提加固补丁：停用门店不可核销/备货；售后中订单阻断凭证；四位码失败限流按门店串行化。不改 0040/0041。
-- 员工门店权限（HQ 角色沿用现有全店 scope；其余须显式库位授权）
CREATE OR REPLACE FUNCTION public.commerce_pickup_actor_can(p_actor uuid, p_location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_actor IS NOT NULL AND p_location_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.inv_locations WHERE id = p_location_id AND kind = 'shop' AND is_active)
    AND (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('super_admin','hq_operator'))
      OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('store_manager','store_staff'))
          AND EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor AND location_id = p_location_id)))
$$;

-- 订单/子单是否阻断凭证：返回原因或 NULL
CREATE OR REPLACE FUNCTION public.commerce_pickup_block_reason(p_order_id uuid, p_fulfillment_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN o.order_status IN ('cancelled','closed') THEN 'cancelled'
    WHEN o.order_status = 'after_sale' THEN 'after_sale_blocked'
    WHEN o.payment_status IN ('refund_pending','partially_refunded','refunded') THEN 'refund_blocked'
    WHEN o.payment_status <> 'paid' THEN 'unpaid'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status IN ('pending','processing','succeeded')) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refund_intents ri WHERE ri.order_id = o.id AND ri.state IN ('queued','processing','manual_review','succeeded')) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.fulfillment_shortages s WHERE s.fulfillment_id = p_fulfillment_id AND s.status IN ('pending_customer','customer_accepted')) THEN 'shortage_blocked'
    ELSE NULL END
  FROM public.commerce_orders o WHERE o.id = p_order_id
$$;

CREATE OR REPLACE FUNCTION public.commerce_pickup_redeem(
  p_actor_user_id uuid, p_location_id uuid, p_qr_payload text, p_code text,
  p_idempotency_key text, p_expected_fulfillment_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_method text; v_prev jsonb; v_code public.commerce_pickup_codes; v_order public.commerce_orders;
  v_f public.fulfillments; v_block text; v_res jsonb; v_fail_actor int; v_fail_loc int; v_now timestamptz := now();
BEGIN
  IF coalesce(p_idempotency_key,'') !~ '^[A-Za-z0-9_-]{8,100}$' OR p_location_id IS NULL
     OR (p_qr_payload IS NULL) = (p_code IS NULL)
     OR (p_qr_payload IS NOT NULL AND p_qr_payload !~ '^BOOMER_PICKUP:[0-9a-f]{64}$')
     OR (p_code IS NOT NULL AND p_code !~ '^[0-9]{4}$') THEN
    RETURN jsonb_build_object('ok', false, 'result', 'invalid_input');
  END IF;
  IF NOT public.commerce_pickup_actor_can(p_actor_user_id, p_location_id) THEN
    RETURN jsonb_build_object('ok', false, 'result', 'forbidden');
  END IF;
  v_method := CASE WHEN p_qr_payload IS NOT NULL THEN 'qr' ELSE 'code' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('pickup_redeem:' || p_actor_user_id::text || ':' || p_idempotency_key, 0));
  SELECT response INTO v_prev FROM public.commerce_pickup_audit
   WHERE actor_user_id = p_actor_user_id AND action = 'redeem' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_prev || jsonb_build_object('replayed', true); END IF;

  IF v_method = 'code' THEN
    -- 同店手输尝试串行化：计数 → 查询 → 审计写入在同一事务锁内，不同幂等键并发也不能越过限流（QR 不经此锁）。
    PERFORM pg_advisory_xact_lock(hashtextextended('pickup_code_rl:' || p_location_id::text, 0));
    SELECT count(*) INTO v_fail_actor FROM public.commerce_pickup_audit
     WHERE actor_user_id = p_actor_user_id AND location_id = p_location_id AND action = 'redeem' AND method = 'code'
       AND NOT success AND result IN ('not_found','rate_limited') AND created_at > v_now - interval '15 minutes';
    SELECT count(*) INTO v_fail_loc FROM public.commerce_pickup_audit
     WHERE location_id = p_location_id AND action = 'redeem' AND method = 'code'
       AND NOT success AND result = 'not_found' AND created_at > v_now - interval '15 minutes';
    IF v_fail_actor >= 5 OR v_fail_loc >= 20 THEN
      v_res := jsonb_build_object('ok', false, 'result', 'rate_limited');
      INSERT INTO public.commerce_pickup_audit (actor_user_id, location_id, action, method, success, result, idempotency_key, response)
      VALUES (p_actor_user_id, p_location_id, 'redeem', v_method, false, 'rate_limited', p_idempotency_key, v_res);
      RETURN v_res;
    END IF;
    SELECT * INTO v_code FROM public.commerce_pickup_codes
     WHERE location_id = p_location_id AND code = p_code AND status = 'active';
  ELSE
    SELECT * INTO v_code FROM public.commerce_pickup_codes WHERE qr_token = substr(p_qr_payload, 15);
  END IF;

  IF v_code.id IS NULL THEN
    v_res := jsonb_build_object('ok', false, 'result', 'not_found');
  ELSIF v_code.location_id <> p_location_id THEN
    v_res := jsonb_build_object('ok', false, 'result', 'wrong_location');
  ELSIF p_expected_fulfillment_id IS NOT NULL AND v_code.fulfillment_id <> p_expected_fulfillment_id THEN
    v_res := jsonb_build_object('ok', false, 'result', 'fulfillment_mismatch');
  END IF;
  IF v_res IS NOT NULL THEN
    INSERT INTO public.commerce_pickup_audit (actor_user_id, location_id, action, method, success, result, idempotency_key, response)
    VALUES (p_actor_user_id, p_location_id, 'redeem', v_method, false, v_res->>'result', p_idempotency_key, v_res);
    RETURN v_res;
  END IF;

  -- 锁顺序与支付确认一致：订单 → 子单 → 凭证 → 支付/退款/缺货
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_code.order_id FOR UPDATE;
  SELECT * INTO v_f FROM public.fulfillments WHERE id = v_code.fulfillment_id FOR UPDATE;
  SELECT * INTO v_code FROM public.commerce_pickup_codes WHERE id = v_code.id FOR UPDATE;
  PERFORM 1 FROM public.commerce_payments WHERE order_id = v_order.id FOR SHARE;
  PERFORM 1 FROM public.commerce_refunds WHERE order_id = v_order.id FOR SHARE;
  PERFORM 1 FROM public.commerce_refund_intents WHERE order_id = v_order.id FOR SHARE;
  PERFORM 1 FROM public.fulfillment_shortages WHERE fulfillment_id = v_f.id FOR SHARE;

  IF v_code.status = 'redeemed' THEN
    v_res := jsonb_build_object('ok', true, 'result', 'already_redeemed', 'fulfillment_id', v_f.id,
      'order_id', v_order.id, 'redeemed_at', v_code.redeemed_at);
  ELSIF v_code.status = 'void' THEN
    v_res := jsonb_build_object('ok', false, 'result', 'cancelled');
  ELSIF v_order.fulfillment_method <> 'pickup' THEN
    v_res := jsonb_build_object('ok', false, 'result', 'not_pickup');
  ELSE
    v_block := public.commerce_pickup_block_reason(v_order.id, v_f.id);
    IF v_block IS NOT NULL THEN
      v_res := jsonb_build_object('ok', false, 'result', v_block);
    ELSIF v_f.status NOT IN ('picked','packed','handover_ready') THEN
      v_res := jsonb_build_object('ok', false, 'result', 'not_ready');
    END IF;
  END IF;

  IF v_res IS NULL THEN
    UPDATE public.fulfillments SET status = 'handed_over', handed_over_at = v_now, updated_at = v_now WHERE id = v_f.id;
    UPDATE public.commerce_pickup_codes SET status = 'redeemed', redeemed_at = v_now, redeemed_by = p_actor_user_id,
      redeem_idempotency_key = p_idempotency_key, updated_at = v_now WHERE id = v_code.id;
    IF NOT EXISTS (SELECT 1 FROM public.fulfillments WHERE order_id = v_order.id AND status <> 'handed_over') THEN
      UPDATE public.commerce_orders SET order_status = 'completed', completed_at = coalesce(completed_at, v_now), updated_at = v_now
       WHERE id = v_order.id AND order_status = 'processing';
    END IF;
    v_res := jsonb_build_object('ok', true, 'result', 'redeemed', 'fulfillment_id', v_f.id,
      'order_id', v_order.id, 'redeemed_at', v_now);
  END IF;
  INSERT INTO public.commerce_pickup_audit (actor_user_id, location_id, action, method, pickup_code_id, fulfillment_id, order_id,
    success, result, idempotency_key, response)
  VALUES (p_actor_user_id, p_location_id, 'redeem', v_method, v_code.id, v_f.id, v_order.id,
    (v_res->>'ok')::boolean, v_res->>'result', p_idempotency_key, v_res);
  RETURN v_res;
END $$;


REVOKE ALL ON FUNCTION public.commerce_pickup_actor_can(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_pickup_block_reason(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_pickup_redeem(uuid, uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_pickup_redeem(uuid, uuid, text, text, text, uuid) TO service_role;
