-- 门店自提：每门店子单提货码(4位, 门店内有效唯一) + 不可猜测二维码令牌；付款验真事务内生成；员工同门店鉴权核销。
CREATE TABLE public.commerce_pickup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES public.fulfillments(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  code text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  qr_token text NOT NULL UNIQUE CHECK (qr_token ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','void')),
  redeemed_at timestamptz,
  redeemed_by uuid,
  redeem_idempotency_key text,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_pickup_codes_active_code ON public.commerce_pickup_codes (location_id, code) WHERE status = 'active';
CREATE INDEX commerce_pickup_codes_order ON public.commerce_pickup_codes (order_id);

CREATE TABLE public.commerce_pickup_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  location_id uuid,
  action text NOT NULL CHECK (action IN ('redeem','mark_ready')),
  method text CHECK (method IN ('qr','code','fulfillment')),
  pickup_code_id uuid REFERENCES public.commerce_pickup_codes(id),
  fulfillment_id uuid,
  order_id uuid,
  success boolean NOT NULL,
  result text NOT NULL,
  idempotency_key text,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_pickup_audit_idem ON public.commerce_pickup_audit (actor_user_id, action, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX commerce_pickup_audit_rate ON public.commerce_pickup_audit (location_id, created_at) WHERE NOT success;

GRANT ALL ON public.commerce_pickup_codes TO service_role;
GRANT ALL ON public.commerce_pickup_audit TO service_role;
ALTER TABLE public.commerce_pickup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_pickup_audit ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.commerce_pickup_codes IS 'Pickup credentials; service_role only, never exposed to public/unauthenticated reads.';

-- 生成凭证（仅已付款自提订单；已有凭证不变，支付重放不换码）
CREATE OR REPLACE FUNCTION public.commerce_pickup_issue_codes(p_order_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_f record; v_code text; v_n integer := 0; v_active integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.commerce_orders WHERE id = p_order_id
                 AND fulfillment_method = 'pickup' AND payment_status = 'paid') THEN
    RETURN 0;
  END IF;
  FOR v_f IN SELECT f.id, f.location_id FROM public.fulfillments f
             WHERE f.order_id = p_order_id AND f.location_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.commerce_pickup_codes c WHERE c.fulfillment_id = f.id)
             ORDER BY f.location_id, f.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pickup_code:' || v_f.location_id::text, 0));
    SELECT count(*) INTO v_active FROM public.commerce_pickup_codes WHERE location_id = v_f.location_id AND status = 'active';
    IF v_active >= 10000 THEN RAISE EXCEPTION 'pickup code capacity full'; END IF;
    SELECT lpad(g::text, 4, '0') INTO v_code FROM generate_series(0, 9999) g
     WHERE NOT EXISTS (SELECT 1 FROM public.commerce_pickup_codes c
                        WHERE c.location_id = v_f.location_id AND c.status = 'active' AND c.code = lpad(g::text, 4, '0'))
     ORDER BY random() LIMIT 1;
    IF v_code IS NULL THEN RAISE EXCEPTION 'pickup code capacity full'; END IF;
    INSERT INTO public.commerce_pickup_codes (order_id, fulfillment_id, location_id, code, qr_token)
    VALUES (p_order_id, v_f.id, v_f.location_id, v_code,
            encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'))
    ON CONFLICT (fulfillment_id) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.tg_commerce_pickup_order_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.fulfillment_method = 'pickup' THEN
    IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
      PERFORM public.commerce_pickup_issue_codes(NEW.id);
    END IF;
    IF NEW.order_status IN ('cancelled','closed') OR NEW.payment_status = 'refunded' THEN
      UPDATE public.commerce_pickup_codes SET status = 'void', void_reason = 'order_' || NEW.order_status || '_' || NEW.payment_status, updated_at = now()
       WHERE order_id = NEW.id AND status = 'active';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_pickup_order_state AFTER UPDATE OF payment_status, order_status ON public.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_commerce_pickup_order_state();

CREATE OR REPLACE FUNCTION public.tg_commerce_pickup_fulfillment_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.commerce_pickup_issue_codes(NEW.order_id);
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_pickup_fulfillment_insert AFTER INSERT ON public.fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.tg_commerce_pickup_fulfillment_insert();

-- 报价：express 原样；pickup 同 shape，运费全 0
CREATE OR REPLACE FUNCTION public.commerce_quote_checkout_v2(p_customer_id uuid, p_items jsonb, p_coupon_id uuid, p_fulfillment_method text DEFAULT 'express')
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v jsonb; v_groups jsonb;
BEGIN
  IF p_fulfillment_method IS NULL OR p_fulfillment_method NOT IN ('express','pickup') THEN
    RAISE EXCEPTION 'invalid fulfillment method';
  END IF;
  v := public.commerce_quote_checkout(p_customer_id, p_items, p_coupon_id);
  IF p_fulfillment_method = 'express' THEN RETURN v; END IF;
  SELECT jsonb_agg(g || jsonb_build_object('shipping_fee_fen', 0, 'remaining_fen', 0) ORDER BY g->>'location_id')
    INTO v_groups FROM jsonb_array_elements(v->'groups') g;
  RETURN v || jsonb_build_object('version', 'pickup_v1', 'fulfillment_method', 'pickup', 'groups', v_groups,
    'shipping_fee_fen', 0, 'cross_store_free', false, 'cross_store_remaining_fen', 0,
    'total_fen', (v->>'subtotal_fen')::bigint - coalesce((v->>'discount_fen')::bigint, 0));
END $$;

-- 自提下单：服务端重算价/券/库存/方式，幂等；不经快递路径
CREATE OR REPLACE FUNCTION public.commerce_create_ordinary_pickup_order(
  p_customer_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text,
  p_quote_snapshot jsonb, p_customer_note text, p_merchant_id text, p_app_id text, p_owned_location_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.commerce_orders; v_listing record; v_locations jsonb; v_quote jsonb; v_coupon_id uuid;
BEGIN
  IF nullif(btrim(p_idempotency_key),'') IS NULL OR length(p_idempotency_key) > 200
     OR p_customer_id IS NULL OR p_merchant_id IS NULL OR p_app_id IS NULL
     OR p_merchant_id !~ '^[0-9]{6,20}$' OR p_app_id !~ '^wx[a-zA-Z0-9]{16}$'
     OR coalesce(cardinality(p_owned_location_ids),0) = 0 THEN
    RAISE EXCEPTION 'invalid ordinary order configuration';
  END IF;
  IF nullif(btrim(p_recipient_name),'') IS NULL OR coalesce(p_recipient_phone,'') !~ '^[0-9+ -]{6,30}$' THEN
    RAISE EXCEPTION 'pickup contact required';
  END IF;
  PERFORM 1 FROM public.commerce_customers WHERE id = p_customer_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active customer not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_order FROM public.commerce_orders
   WHERE customer_id = p_customer_id AND idempotency_key = p_idempotency_key AND source_channel = 'storefront' FOR UPDATE;
  IF FOUND THEN
    IF v_order.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat' THEN RAISE EXCEPTION 'legacy order route cannot be converted'; END IF;
    IF v_order.fulfillment_method IS DISTINCT FROM 'pickup' THEN RAISE EXCEPTION 'idempotency key used by another fulfillment method'; END IF;
    RETURN to_jsonb(v_order);
  END IF;
  v_coupon_id := nullif(p_quote_snapshot->'coupon'->>'id','')::uuid;
  IF v_coupon_id IS NOT NULL THEN
    PERFORM 1 FROM public.pos_customer_coupons WHERE id = v_coupon_id AND customer_id = p_customer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'coupon unavailable'; END IF;
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ordinary order requires items';
  END IF;
  FOR v_listing IN
    SELECT l.id, l.location_id, l.sku_id FROM public.commerce_listings l
     WHERE l.id IN (SELECT (i->>'listing_id')::uuid FROM jsonb_array_elements(p_items) i)
     ORDER BY l.id FOR UPDATE
  LOOP
    IF NOT (v_listing.location_id = ANY(p_owned_location_ids)) OR NOT EXISTS (
      SELECT 1 FROM public.inv_locations WHERE id = v_listing.location_id AND is_active AND kind = 'shop'
    ) THEN RAISE EXCEPTION 'location is not an approved self-operated location'; END IF;
    PERFORM 1 FROM public.inv_skus WHERE id = v_listing.sku_id
      AND sale_ownership = 'owned' AND nullif(btrim(settlement_party_ref),'') IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SKU ownership is not self-operated'; END IF;
  END LOOP;
  v_quote := public.commerce_quote_checkout_v2(p_customer_id, p_items, v_coupon_id, 'pickup');
  IF p_quote_snapshot IS DISTINCT FROM v_quote THEN RAISE EXCEPTION 'shipping quote changed'; END IF;
  IF (v_quote->>'total_fen')::bigint <= 0 THEN RAISE EXCEPTION 'zero payable order not supported'; END IF;
  v_order := public.commerce_create_order_v2(p_customer_id, p_idempotency_key, p_items, p_recipient_name,
    p_recipient_phone, '{}'::jsonb, 'platform', 'STORE_PICKUP', '门店自提', 0, v_quote, p_customer_note);
  UPDATE public.commerce_orders SET fulfillment_method = 'pickup', updated_at = now()
   WHERE id = v_order.id RETURNING * INTO v_order;
  IF v_coupon_id IS NOT NULL THEN
    UPDATE public.pos_customer_coupons SET status = 'reserved', reserved_order_id = v_order.id, updated_at = now()
     WHERE id = v_coupon_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION 'coupon unavailable'; END IF;
  END IF;
  UPDATE public.commerce_order_items i SET
    discount_total = (a->>'discount_fen')::numeric/100,
    discount_snapshot = jsonb_build_object('coupon', v_quote->'coupon', 'gross_fen', a->'gross_fen', 'discount_fen', a->'discount_fen'),
    line_total = ((a->>'gross_fen')::numeric - (a->>'discount_fen')::numeric)/100
    FROM jsonb_array_elements(v_quote->'discount_allocations') a
   WHERE i.order_id = v_order.id AND i.listing_id = (a->>'listing_id')::uuid;
  UPDATE public.commerce_orders SET discount_total = (v_quote->>'discount_fen')::numeric/100,
    discount_snapshot = jsonb_build_object('coupon', v_quote->'coupon', 'allocations', v_quote->'discount_allocations'),
    total_amount = (v_quote->>'total_fen')::numeric/100
   WHERE id = v_order.id RETURNING * INTO v_order;
  PERFORM 1 FROM public.inv_skus WHERE id IN (SELECT stock_sku_id FROM public.inventory_reservation_lines l
    JOIN public.commerce_order_items i ON i.id = l.order_item_id WHERE i.order_id = v_order.id) ORDER BY id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.inventory_reservation_lines l
    JOIN public.commerce_order_items i ON i.id = l.order_item_id
    JOIN public.inv_skus s ON s.id = l.stock_sku_id WHERE i.order_id = v_order.id
    AND (s.sale_ownership <> 'owned' OR nullif(btrim(s.settlement_party_ref),'') IS NOT NULL)) THEN
    RAISE EXCEPTION 'bundle component ownership is not self-operated';
  END IF;
  SELECT jsonb_agg(DISTINCT location_id ORDER BY location_id) INTO v_locations
    FROM public.commerce_order_items WHERE order_id = v_order.id;
  UPDATE public.commerce_order_items SET ownership_snapshot = 'owned',
    settlement_snapshot = jsonb_build_object('mode','ordinary_wechat','merchant_id',p_merchant_id,
      'app_id',p_app_id,'location_id',location_id,'ownership','owned','line_total_fen',(line_total*100)::bigint)
   WHERE order_id = v_order.id;
  UPDATE public.commerce_orders SET payment_route = jsonb_build_object('version',1,'mode','ordinary_wechat',
    'merchant_id',p_merchant_id,'app_id',p_app_id,'customer_id',p_customer_id,'location_ids',v_locations,
    'currency',currency,'total_fen',(total_amount*100)::bigint)
   WHERE id = v_order.id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END $$;

-- 员工门店权限（HQ 角色沿用现有全店 scope；其余须显式库位授权）
CREATE OR REPLACE FUNCTION public.commerce_pickup_actor_can(p_actor uuid, p_location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_actor IS NOT NULL AND p_location_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.inv_locations WHERE id = p_location_id AND kind = 'shop')
    AND (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('super_admin','hq_operator'))
      OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('store_manager','store_staff'))
          AND EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor AND location_id = p_location_id)))
$$;

-- 订单/子单是否阻断凭证：返回原因或 NULL
CREATE OR REPLACE FUNCTION public.commerce_pickup_block_reason(p_order_id uuid, p_fulfillment_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN o.order_status IN ('cancelled','closed') THEN 'cancelled'
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

-- 备货完成：只改子单履约状态与拣货数量，不动库存（付款时已扣）
CREATE OR REPLACE FUNCTION public.commerce_pickup_mark_ready(
  p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_f public.fulfillments; v_order public.commerce_orders; v_block text; v_res jsonb; v_prev jsonb;
BEGIN
  IF coalesce(p_idempotency_key,'') !~ '^[A-Za-z0-9_-]{8,100}$' OR p_fulfillment_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'result', 'invalid_input');
  END IF;
  IF NOT public.commerce_pickup_actor_can(p_actor_user_id, p_location_id) THEN
    RETURN jsonb_build_object('ok', false, 'result', 'forbidden');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pickup_ready:' || p_actor_user_id::text || ':' || p_idempotency_key, 0));
  SELECT response INTO v_prev FROM public.commerce_pickup_audit
   WHERE actor_user_id = p_actor_user_id AND action = 'mark_ready' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_prev || jsonb_build_object('replayed', true); END IF;
  SELECT f.* INTO v_f FROM public.fulfillments f WHERE f.id = p_fulfillment_id;
  IF v_f.id IS NULL OR v_f.location_id <> p_location_id THEN
    RETURN jsonb_build_object('ok', false, 'result', 'not_found');
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_f.order_id FOR UPDATE;
  SELECT * INTO v_f FROM public.fulfillments WHERE id = p_fulfillment_id FOR UPDATE;
  IF v_order.fulfillment_method <> 'pickup' THEN
    v_res := jsonb_build_object('ok', false, 'result', 'not_pickup');
  ELSE
    v_block := public.commerce_pickup_block_reason(v_order.id, v_f.id);
    IF v_block IS NOT NULL THEN v_res := jsonb_build_object('ok', false, 'result', v_block);
    ELSIF v_f.status IN ('handover_ready','handed_over') THEN v_res := jsonb_build_object('ok', true, 'result', 'already_ready', 'status', v_f.status);
    ELSIF v_f.status = 'exception' THEN v_res := jsonb_build_object('ok', false, 'result', 'exception');
    END IF;
  END IF;
  IF v_res IS NULL THEN
    UPDATE public.fulfillment_items SET picked_qty = expected_qty, packed_qty = expected_qty,
      picked_at = coalesce(picked_at, now()), packed_at = coalesce(packed_at, now()) WHERE fulfillment_id = v_f.id;
    UPDATE public.fulfillments SET status = 'handover_ready', picked_at = coalesce(picked_at, now()),
      packed_at = coalesce(packed_at, now()), updated_at = now() WHERE id = v_f.id;
    v_res := jsonb_build_object('ok', true, 'result', 'ready', 'fulfillment_id', v_f.id);
  END IF;
  INSERT INTO public.commerce_pickup_audit (actor_user_id, location_id, action, method, fulfillment_id, order_id, success, result, idempotency_key, response)
  VALUES (p_actor_user_id, p_location_id, 'mark_ready', 'fulfillment', v_f.id, v_order.id, (v_res->>'ok')::boolean, v_res->>'result', p_idempotency_key, v_res);
  RETURN v_res;
END $$;

REVOKE ALL ON FUNCTION public.commerce_pickup_issue_codes(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_commerce_pickup_order_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_commerce_pickup_fulfillment_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_quote_checkout_v2(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_create_ordinary_pickup_order(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_pickup_actor_can(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_pickup_block_reason(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_pickup_redeem(uuid, uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_pickup_mark_ready(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_quote_checkout_v2(uuid, jsonb, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_ordinary_pickup_order(uuid, text, jsonb, text, text, jsonb, text, text, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_pickup_redeem(uuid, uuid, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_pickup_mark_ready(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_pickup_issue_codes(uuid) TO service_role;
