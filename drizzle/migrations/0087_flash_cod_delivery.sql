-- 同城闪送到付（flash COD）：报价/下单/人工送达登记；配送费一律到付，系统不收运费
-- 1) 配送方式与承运商枚举放宽（仅加值，不改旧值）
ALTER TABLE public.commerce_orders DROP CONSTRAINT commerce_orders_fulfillment_method_check;
ALTER TABLE public.commerce_orders ADD CONSTRAINT commerce_orders_fulfillment_method_check
  CHECK (fulfillment_method = ANY (ARRAY['shipping','pickup','carryout','flash']));
ALTER TABLE public.commerce_orders DROP CONSTRAINT commerce_orders_courier_provider_check;
ALTER TABLE public.commerce_orders ADD CONSTRAINT commerce_orders_courier_provider_check
  CHECK (courier_provider = ANY (ARRAY['sf','cainiao','platform','flash']));

-- 2) 报价：express 原样；pickup 不变；flash 零平台运费 + delivery_fee_payment=cod，仅单店
CREATE OR REPLACE FUNCTION public.commerce_quote_checkout_v2(p_customer_id uuid, p_items jsonb, p_coupon_id uuid, p_fulfillment_method text DEFAULT 'express')
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v jsonb; v_groups jsonb; v_locations int;
BEGIN
  IF p_fulfillment_method IS NULL OR p_fulfillment_method NOT IN ('express','pickup','flash') THEN
    RAISE EXCEPTION 'invalid fulfillment method';
  END IF;
  v := public.commerce_quote_checkout(p_customer_id, p_items, p_coupon_id);
  IF p_fulfillment_method = 'express' THEN RETURN v; END IF;
  SELECT count(DISTINCT g->>'location_id') INTO v_locations FROM jsonb_array_elements(v->'groups') g;
  IF p_fulfillment_method = 'flash' AND v_locations > 1 THEN
    RAISE EXCEPTION 'flash requires single store';
  END IF;
  SELECT jsonb_agg(g || jsonb_build_object('shipping_fee_fen', 0, 'remaining_fen', 0) ORDER BY g->>'location_id')
    INTO v_groups FROM jsonb_array_elements(v->'groups') g;
  IF p_fulfillment_method = 'pickup' THEN
    RETURN v || jsonb_build_object('version', 'pickup_v1', 'fulfillment_method', 'pickup', 'groups', v_groups,
      'shipping_fee_fen', 0, 'cross_store_free', false, 'cross_store_remaining_fen', 0,
      'total_fen', (v->>'subtotal_fen')::bigint - coalesce((v->>'discount_fen')::bigint, 0));
  END IF;
  RETURN v || jsonb_build_object('version', 'flash_cod_v1', 'fulfillment_method', 'flash', 'groups', v_groups,
    'shipping_fee_fen', 0, 'cross_store_free', false, 'cross_store_remaining_fen', 0,
    'delivery_fee_payment', 'cod',
    'total_fen', (v->>'subtotal_fen')::bigint - coalesce((v->>'discount_fen')::bigint, 0));
END $$;

-- 3) 闪送下单：服务端重算价/券/库存/单店，幂等；商品款在线付，配送费到付（系统不收）
CREATE OR REPLACE FUNCTION public.commerce_create_ordinary_flash_order(
  p_customer_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text,
  p_shipping_address jsonb, p_quote_snapshot jsonb, p_customer_note text, p_merchant_id text, p_app_id text, p_owned_location_ids uuid[])
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
    RAISE EXCEPTION 'flash recipient required';
  END IF;
  IF jsonb_typeof(p_shipping_address) IS DISTINCT FROM 'object' OR p_shipping_address = '{}'::jsonb THEN
    RAISE EXCEPTION 'flash address required';
  END IF;
  PERFORM 1 FROM public.commerce_customers WHERE id = p_customer_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active customer not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || p_idempotency_key, 0));
  SELECT * INTO v_order FROM public.commerce_orders
   WHERE customer_id = p_customer_id AND idempotency_key = p_idempotency_key AND source_channel = 'storefront' FOR UPDATE;
  IF FOUND THEN
    IF v_order.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat' THEN RAISE EXCEPTION 'legacy order route cannot be converted'; END IF;
    IF v_order.fulfillment_method IS DISTINCT FROM 'flash' THEN RAISE EXCEPTION 'idempotency key used by another fulfillment method'; END IF;
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
  v_quote := public.commerce_quote_checkout_v2(p_customer_id, p_items, v_coupon_id, 'flash');
  IF p_quote_snapshot IS DISTINCT FROM v_quote THEN RAISE EXCEPTION 'shipping quote changed'; END IF;
  IF (v_quote->>'total_fen')::bigint <= 0 THEN RAISE EXCEPTION 'zero payable order not supported'; END IF;
  v_order := public.commerce_create_order_v2(p_customer_id, p_idempotency_key, p_items, p_recipient_name,
    p_recipient_phone, p_shipping_address, 'flash', 'SHANSONG_COD', '同城闪送（配送费到付）', 0, v_quote, p_customer_note);
  UPDATE public.commerce_orders SET fulfillment_method = 'flash', updated_at = now()
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
REVOKE ALL ON FUNCTION public.commerce_create_ordinary_flash_order(uuid,text,jsonb,text,text,jsonb,jsonb,text,text,text,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_create_ordinary_flash_order(uuid,text,jsonb,text,text,jsonb,jsonb,text,text,text,uuid[]) TO service_role;

-- 4) 手工发货禁止闪送单伪造快递单号（在既有 8 参数函数内加一行阻断，其余逻辑逐字保留）
CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text, p_carrier_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  f record; o record; s record; ln jsonb;
  v_ship uuid; v_tracking text := upper(btrim(coalesce(p_tracking_no,'')));
  v_label text := nullif(btrim(coalesce(p_carrier_label,'')), '');
  v_req jsonb := '{}'::jsonb;
  v_canon text; v_fp text; v_mismatch text; v_block text;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('sf','cainiao','manual') THEN RETURN jsonb_build_object('ok',false,'result','invalid_provider'); END IF;
  IF p_provider = 'sf' THEN v_label := '顺丰速运';
  ELSIF p_provider = 'cainiao' THEN v_label := '菜鸟';
  ELSIF v_label IS NULL OR char_length(v_label) > 40 OR v_label ~ E'[\x01-\x1f\x7f]' THEN
    RETURN jsonb_build_object('ok',false,'result','invalid_carrier_label');
  END IF;
  IF v_tracking !~ '^[A-Z0-9-]{4,64}$' THEN RETURN jsonb_build_object('ok',false,'result','invalid_tracking_no'); END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{6,80}$' THEN RETURN jsonb_build_object('ok',false,'result','invalid_idempotency_key'); END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 200 THEN
    RETURN jsonb_build_object('ok',false,'result','invalid_lines');
  END IF;
  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(ln) <> 'object' OR coalesce(ln->>'fulfillment_item_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(ln->>'quantity','') !~ '^[1-9][0-9]{0,4}$' THEN
      RETURN jsonb_build_object('ok',false,'result','invalid_lines');
    END IF;
    IF v_req ? lower(ln->>'fulfillment_item_id') THEN RETURN jsonb_build_object('ok',false,'result','invalid_lines'); END IF;
    v_req := v_req || jsonb_build_object(lower(ln->>'fulfillment_item_id'), (ln->>'quantity')::int);
  END LOOP;
  SELECT string_agg(k || ':' || (v_req->>k), ',' ORDER BY k) INTO v_canon FROM jsonb_object_keys(v_req) k;
  v_fp := md5(p_provider || '|' || v_label || '|' || v_tracking || '|' || v_canon);

  SELECT * INTO f FROM public.fulfillments WHERE id = p_fulfillment_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','not_found'); END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_user_id AND role::text IN ('super_admin','hq_operator'))
       OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_user_id AND role::text IN ('store_manager','store_staff','warehouse_staff'))
           AND EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor_user_id AND location_id = f.location_id))) THEN
    RETURN jsonb_build_object('ok',false,'result','forbidden');
  END IF;
  IF p_location_id IS NOT NULL AND p_location_id IS DISTINCT FROM f.location_id THEN
    RETURN jsonb_build_object('ok',false,'result','location_forbidden');
  END IF;
  SELECT * INTO o FROM public.commerce_orders WHERE id = f.order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','not_found'); END IF;
  SELECT * INTO f FROM public.fulfillments WHERE id = p_fulfillment_id FOR UPDATE;

  SELECT * INTO s FROM public.shipments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF s.fulfillment_id = f.id AND s.request_fingerprint = v_fp THEN
      RETURN jsonb_build_object('ok',true,'result','shipped','replayed',true,'shipment_id',s.id,'fulfillment_id',f.id,
        'provider',s.provider,'carrier_label',s.carrier_label,'tracking_no',s.tracking_no);
    END IF;
    RETURN jsonb_build_object('ok',false,'result','idempotency_conflict');
  END IF;
  IF EXISTS (SELECT 1 FROM public.shipments WHERE fulfillment_id = f.id) THEN
    RETURN jsonb_build_object('ok',false,'result','already_shipped');
  END IF;

  IF o.fulfillment_method = 'pickup' THEN RETURN jsonb_build_object('ok',false,'result','pickup_order'); END IF;
  IF o.fulfillment_method = 'flash' THEN RETURN jsonb_build_object('ok',false,'result','flash_order'); END IF;
  IF f.status IN ('handed_over','exception','unallocated') THEN RETURN jsonb_build_object('ok',false,'result','invalid_status'); END IF;
  PERFORM 1 FROM public.fulfillment_items WHERE fulfillment_id = f.id ORDER BY id FOR UPDATE;

  v_block := public.commerce_order_settlement_block(o.id);
  IF v_block IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'result',v_block); END IF;
  IF EXISTS (SELECT 1 FROM public.fulfillment_shortages sh WHERE sh.fulfillment_id = f.id AND sh.status = 'pending_customer') THEN
    RETURN jsonb_build_object('ok',false,'result','shortage_blocked');
  END IF;

  WITH ship AS (
    SELECT it.id, greatest(0, it.expected_qty - public.commerce_item_cleared_shortage_qty(it.id))::int AS q
      FROM public.fulfillment_items it WHERE it.fulfillment_id = f.id),
  req AS (SELECT k::uuid AS id, (v_req->>k)::int AS q FROM jsonb_object_keys(v_req) k)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM req WHERE req.id NOT IN (SELECT id FROM ship)) THEN 'invalid_lines'
    WHEN EXISTS (SELECT 1 FROM req JOIN ship USING (id) WHERE req.q > ship.q) THEN 'qty_exceeded'
    WHEN NOT EXISTS (SELECT 1 FROM ship WHERE q > 0) THEN 'nothing_to_ship'
    WHEN EXISTS (SELECT 1 FROM ship LEFT JOIN req USING (id) WHERE ship.q > 0 AND coalesce(req.q,0) <> ship.q) THEN 'lines_incomplete'
    ELSE NULL END INTO v_mismatch;
  IF v_mismatch IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'result',v_mismatch); END IF;

  UPDATE public.fulfillment_items it SET picked_qty = greatest(coalesce(it.picked_qty,0), (v_req->>lower(it.id::text))::int),
         picked_at = coalesce(it.picked_at, now())
   WHERE it.fulfillment_id = f.id AND v_req ? lower(it.id::text) AND coalesce(it.picked_qty,0) < (v_req->>lower(it.id::text))::int;
  INSERT INTO public.shipments (fulfillment_id, provider, carrier_label, status, tracking_no, idempotency_key, request_fingerprint, booked_at)
  VALUES (f.id, p_provider, v_label, 'booked', v_tracking, p_idempotency_key, v_fp, now()) RETURNING id INTO v_ship;
  UPDATE public.fulfillments SET status = 'handed_over', handed_over_at = now() WHERE id = f.id;
  RETURN jsonb_build_object('ok',true,'result','shipped','replayed',false,'shipment_id',v_ship,'fulfillment_id',f.id,
    'provider',p_provider,'carrier_label',v_label,'tracking_no',v_tracking);
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO s FROM public.shipments WHERE idempotency_key = p_idempotency_key;
    IF FOUND AND s.fulfillment_id = p_fulfillment_id AND s.request_fingerprint = v_fp THEN
      RETURN jsonb_build_object('ok',true,'result','shipped','replayed',true,'shipment_id',s.id,'fulfillment_id',s.fulfillment_id,
        'provider',s.provider,'carrier_label',s.carrier_label,'tracking_no',s.tracking_no);
    END IF;
    RETURN jsonb_build_object('ok',false,'result', CASE WHEN FOUND THEN 'idempotency_conflict' ELSE 'already_shipped' END);
END $$;

-- 5) 闪送人工送达登记：不强迫伪造快递单号；权限/付款/售后/缺货/明细/幂等与手工发货同一套数据库内校验
CREATE OR REPLACE FUNCTION public.commerce_flash_deliver_fulfillment(
  p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_lines jsonb, p_idempotency_key text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  f record; o record; s record; ln jsonb;
  v_ship uuid; v_note text := nullif(btrim(coalesce(p_note,'')), '');
  v_req jsonb := '{}'::jsonb;
  v_canon text; v_fp text; v_mismatch text; v_block text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{6,80}$' THEN RETURN jsonb_build_object('ok',false,'result','invalid_idempotency_key'); END IF;
  IF v_note IS NOT NULL AND (char_length(v_note) > 120 OR v_note ~ E'[\x01-\x1f\x7f]') THEN
    RETURN jsonb_build_object('ok',false,'result','invalid_note');
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 200 THEN
    RETURN jsonb_build_object('ok',false,'result','invalid_lines');
  END IF;
  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(ln) <> 'object' OR coalesce(ln->>'fulfillment_item_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(ln->>'quantity','') !~ '^[1-9][0-9]{0,4}$' THEN
      RETURN jsonb_build_object('ok',false,'result','invalid_lines');
    END IF;
    IF v_req ? lower(ln->>'fulfillment_item_id') THEN RETURN jsonb_build_object('ok',false,'result','invalid_lines'); END IF;
    v_req := v_req || jsonb_build_object(lower(ln->>'fulfillment_item_id'), (ln->>'quantity')::int);
  END LOOP;
  SELECT string_agg(k || ':' || (v_req->>k), ',' ORDER BY k) INTO v_canon FROM jsonb_object_keys(v_req) k;
  v_fp := md5('flash|' || coalesce(v_note,'') || '|' || v_canon);

  SELECT * INTO f FROM public.fulfillments WHERE id = p_fulfillment_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','not_found'); END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_user_id AND role::text IN ('super_admin','hq_operator'))
       OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_user_id AND role::text IN ('store_manager','store_staff','warehouse_staff'))
           AND EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor_user_id AND location_id = f.location_id))) THEN
    RETURN jsonb_build_object('ok',false,'result','forbidden');
  END IF;
  IF p_location_id IS NOT NULL AND p_location_id IS DISTINCT FROM f.location_id THEN
    RETURN jsonb_build_object('ok',false,'result','location_forbidden');
  END IF;
  SELECT * INTO o FROM public.commerce_orders WHERE id = f.order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','not_found'); END IF;
  SELECT * INTO f FROM public.fulfillments WHERE id = p_fulfillment_id FOR UPDATE;

  SELECT * INTO s FROM public.shipments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF s.fulfillment_id = f.id AND s.request_fingerprint = v_fp THEN
      RETURN jsonb_build_object('ok',true,'result','delivered','replayed',true,'shipment_id',s.id,'fulfillment_id',f.id,
        'provider',s.provider,'carrier_label',s.carrier_label,'tracking_no',s.tracking_no);
    END IF;
    RETURN jsonb_build_object('ok',false,'result','idempotency_conflict');
  END IF;
  IF EXISTS (SELECT 1 FROM public.shipments WHERE fulfillment_id = f.id) THEN
    RETURN jsonb_build_object('ok',false,'result','already_shipped');
  END IF;

  IF o.fulfillment_method IS DISTINCT FROM 'flash' THEN RETURN jsonb_build_object('ok',false,'result','not_flash_order'); END IF;
  IF f.status IN ('handed_over','exception','unallocated') THEN RETURN jsonb_build_object('ok',false,'result','invalid_status'); END IF;
  PERFORM 1 FROM public.fulfillment_items WHERE fulfillment_id = f.id ORDER BY id FOR UPDATE;

  v_block := public.commerce_order_settlement_block(o.id);
  IF v_block IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'result',v_block); END IF;
  IF EXISTS (SELECT 1 FROM public.fulfillment_shortages sh WHERE sh.fulfillment_id = f.id AND sh.status = 'pending_customer') THEN
    RETURN jsonb_build_object('ok',false,'result','shortage_blocked');
  END IF;

  WITH ship AS (
    SELECT it.id, greatest(0, it.expected_qty - public.commerce_item_cleared_shortage_qty(it.id))::int AS q
      FROM public.fulfillment_items it WHERE it.fulfillment_id = f.id),
  req AS (SELECT k::uuid AS id, (v_req->>k)::int AS q FROM jsonb_object_keys(v_req) k)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM req WHERE req.id NOT IN (SELECT id FROM ship)) THEN 'invalid_lines'
    WHEN EXISTS (SELECT 1 FROM req JOIN ship USING (id) WHERE req.q > ship.q) THEN 'qty_exceeded'
    WHEN NOT EXISTS (SELECT 1 FROM ship WHERE q > 0) THEN 'nothing_to_ship'
    WHEN EXISTS (SELECT 1 FROM ship LEFT JOIN req USING (id) WHERE ship.q > 0 AND coalesce(req.q,0) <> ship.q) THEN 'lines_incomplete'
    ELSE NULL END INTO v_mismatch;
  IF v_mismatch IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'result',v_mismatch); END IF;

  UPDATE public.fulfillment_items it SET picked_qty = greatest(coalesce(it.picked_qty,0), (v_req->>lower(it.id::text))::int),
         picked_at = coalesce(it.picked_at, now())
   WHERE it.fulfillment_id = f.id AND v_req ? lower(it.id::text) AND coalesce(it.picked_qty,0) < (v_req->>lower(it.id::text))::int;
  INSERT INTO public.shipments (fulfillment_id, provider, service_code, carrier_label, status, tracking_no, idempotency_key, request_fingerprint, booked_at)
  VALUES (f.id, 'flash', 'SHANSONG_COD', '同城闪送（配送费到付）', 'booked', NULL, p_idempotency_key, v_fp, now()) RETURNING id INTO v_ship;
  UPDATE public.fulfillments SET status = 'handed_over', handed_over_at = now() WHERE id = f.id;
  RETURN jsonb_build_object('ok',true,'result','delivered','replayed',false,'shipment_id',v_ship,'fulfillment_id',f.id,
    'provider','flash','carrier_label','同城闪送（配送费到付）','tracking_no',NULL);
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO s FROM public.shipments WHERE idempotency_key = p_idempotency_key;
    IF FOUND AND s.fulfillment_id = p_fulfillment_id AND s.request_fingerprint = v_fp THEN
      RETURN jsonb_build_object('ok',true,'result','delivered','replayed',true,'shipment_id',s.id,'fulfillment_id',s.fulfillment_id,
        'provider',s.provider,'carrier_label',s.carrier_label,'tracking_no',s.tracking_no);
    END IF;
    RETURN jsonb_build_object('ok',false,'result', CASE WHEN FOUND THEN 'idempotency_conflict' ELSE 'already_shipped' END);
END $$;
REVOKE ALL ON FUNCTION public.commerce_flash_deliver_fulfillment(uuid,uuid,uuid,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_flash_deliver_fulfillment(uuid,uuid,uuid,jsonb,text,text) TO service_role;