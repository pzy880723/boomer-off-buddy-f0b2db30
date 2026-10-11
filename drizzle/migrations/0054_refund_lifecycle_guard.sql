-- 退款生命周期一致的履约放行（网页/手持共用）：
--   * 缺货“已清算”只认真实证据链：shortage customer_accepted → intent(同 shortage/order) succeeded
--     → commerce_refunds(intent.refund_id) succeeded，且售后单/支付/金额一致；不只看 refund_state 字符串。
--   * 订单 partially_refunded 仅当每笔成功退款都能对应到已清算缺货时放行；全额退款/退款进行中/失败/人工核实/
--     非缺货退款/售后/取消一律阻断。
--   * 剩余应发量 = expected − 已清算缺货量；手工发货、拣货完成、自提备货/核销同一口径。
--   * 锁顺序统一：订单 → 子单 → 子单行（与支付回调 订单→支付→退款、自提一致），避免互锁。
-- 回滚（按序）：以 tests/sql/refund_lifecycle/live_functions.sql 中快照重放
--   commerce_pickup_block_reason / commerce_pickup_mark_ready / fulfillment_complete_pick，
--   重放 drizzle/migrations/0053_manual_ship_reliability.sql 中 8 参 commerce_manual_ship_fulfillment；
--   再 DROP FUNCTION public.commerce_fulfillment_pick_facts(uuid), public.commerce_fulfillment_block(uuid),
--   public.commerce_order_settlement_block(uuid), public.commerce_item_cleared_shortage_qty(uuid),
--   public.commerce_shortage_refund_cleared(uuid);

CREATE OR REPLACE FUNCTION public.commerce_shortage_refund_cleared(p_shortage_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fulfillment_shortages s
      JOIN public.commerce_refund_intents i ON i.id = s.refund_intent_id AND i.shortage_id = s.id AND i.order_id = s.order_id
      JOIN public.commerce_refunds r ON r.id = i.refund_id AND r.order_id = s.order_id
                                   AND r.payment_id = i.payment_id AND r.after_sale_id IS NOT DISTINCT FROM i.after_sale_id
     WHERE s.id = p_shortage_id AND s.status = 'customer_accepted'
       AND i.state = 'succeeded' AND r.status = 'succeeded'
       AND round(r.amount * 100) = i.amount_fen AND i.amount_fen > 0)
$$;

CREATE OR REPLACE FUNCTION public.commerce_item_cleared_shortage_qty(p_fulfillment_item_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(sum(s.quantity), 0)::int FROM public.fulfillment_shortages s
   WHERE s.fulfillment_item_id = p_fulfillment_item_id AND public.commerce_shortage_refund_cleared(s.id)
$$;

CREATE OR REPLACE FUNCTION public.commerce_order_settlement_block(p_order_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN o.id IS NULL THEN 'not_found'
    WHEN o.order_status IN ('cancelled','closed') THEN 'cancelled'
    WHEN o.payment_status IN ('refunded','refund_pending') THEN 'refund_blocked'
    WHEN o.order_status = 'after_sale' THEN 'after_sale_blocked'
    WHEN o.payment_status NOT IN ('paid','partially_refunded') THEN 'unpaid'
    WHEN EXISTS (SELECT 1 FROM public.commerce_payments p WHERE p.order_id = o.id AND p.status = 'refunded') THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status IN ('pending','processing')) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refund_intents i WHERE i.order_id = o.id AND i.state <> 'succeeded') THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refund_intents i WHERE i.order_id = o.id AND i.state = 'succeeded'
                  AND NOT public.commerce_shortage_refund_cleared(i.shortage_id)) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.fulfillment_shortages s WHERE s.order_id = o.id AND s.status <> 'withdrawn'
                  AND (s.refund_state IN ('manual_review','failed','processing','queued','refund_pending')
                       OR (s.status = 'customer_accepted' AND NOT public.commerce_shortage_refund_cleared(s.id)))) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status = 'succeeded'
                  AND NOT EXISTS (SELECT 1 FROM public.commerce_refund_intents i WHERE i.refund_id = r.id AND i.state = 'succeeded'
                                   AND public.commerce_shortage_refund_cleared(i.shortage_id))) THEN 'refund_blocked'
    WHEN o.payment_status = 'partially_refunded'
         AND NOT EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status = 'succeeded') THEN 'refund_blocked'
    ELSE NULL END
  FROM (SELECT p_order_id AS id) x LEFT JOIN public.commerce_orders o ON o.id = x.id
$$;

CREATE OR REPLACE FUNCTION public.commerce_fulfillment_block(p_fulfillment_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.commerce_order_settlement_block(f.order_id),
    CASE WHEN EXISTS (SELECT 1 FROM public.fulfillment_shortages s WHERE s.fulfillment_id = f.id AND s.status = 'pending_customer') THEN 'shortage_blocked'
         WHEN NOT EXISTS (SELECT 1 FROM public.fulfillment_items it WHERE it.fulfillment_id = f.id
                           AND it.expected_qty - public.commerce_item_cleared_shortage_qty(it.id) > 0) THEN 'nothing_to_ship'
         ELSE NULL END)
  FROM public.fulfillments f WHERE f.id = p_fulfillment_id
$$;

CREATE OR REPLACE FUNCTION public.commerce_fulfillment_pick_facts(p_fulfillment_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'settlement_block', public.commerce_order_settlement_block(f.order_id),
    'cleared_shortage_ids', coalesce((SELECT jsonb_agg(s.id ORDER BY s.id) FROM public.fulfillment_shortages s
                                      WHERE s.fulfillment_id = f.id AND public.commerce_shortage_refund_cleared(s.id)), '[]'::jsonb))
  FROM public.fulfillments f WHERE f.id = p_fulfillment_id
$$;

REVOKE ALL ON FUNCTION public.commerce_shortage_refund_cleared(uuid), public.commerce_item_cleared_shortage_qty(uuid),
  public.commerce_order_settlement_block(uuid), public.commerce_fulfillment_block(uuid), public.commerce_fulfillment_pick_facts(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_shortage_refund_cleared(uuid), public.commerce_item_cleared_shortage_qty(uuid),
  public.commerce_order_settlement_block(uuid), public.commerce_fulfillment_block(uuid), public.commerce_fulfillment_pick_facts(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_pickup_block_reason(p_order_id uuid, p_fulfillment_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN f.order_id IS DISTINCT FROM p_order_id THEN 'not_found'
              ELSE CASE b WHEN 'nothing_to_ship' THEN 'shortage_blocked' ELSE b END END
    FROM public.fulfillments f, LATERAL (SELECT public.commerce_fulfillment_block(f.id) AS b) x
   WHERE f.id = p_fulfillment_id
$$;

CREATE OR REPLACE FUNCTION public.commerce_pickup_mark_ready(p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_idempotency_key text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
  PERFORM 1 FROM public.fulfillment_items WHERE fulfillment_id = v_f.id ORDER BY id FOR UPDATE;
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
    UPDATE public.fulfillment_items it SET
      picked_qty = greatest(it.expected_qty - public.commerce_item_cleared_shortage_qty(it.id), 0),
      packed_qty = greatest(it.expected_qty - public.commerce_item_cleared_shortage_qty(it.id), 0),
      picked_at = coalesce(picked_at, now()), packed_at = coalesce(packed_at, now())
     WHERE it.fulfillment_id = v_f.id;
    UPDATE public.fulfillments SET status = 'handover_ready', picked_at = coalesce(picked_at, now()),
      packed_at = coalesce(packed_at, now()), updated_at = now() WHERE id = v_f.id;
    v_res := jsonb_build_object('ok', true, 'result', 'ready', 'fulfillment_id', v_f.id);
  END IF;
  INSERT INTO public.commerce_pickup_audit (actor_user_id, location_id, action, method, fulfillment_id, order_id, success, result, idempotency_key, response)
  VALUES (p_actor_user_id, p_location_id, 'mark_ready', 'fulfillment', v_f.id, v_order.id, (v_res->>'ok')::boolean, v_res->>'result', p_idempotency_key, v_res);
  RETURN v_res;
END $function$;

CREATE OR REPLACE FUNCTION public.fulfillment_complete_pick(p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid)
 RETURNS fulfillments LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.fulfillments;
  v_order_status text;
  v_block text;
BEGIN
  SELECT * INTO v_row FROM public.fulfillments WHERE id = p_fulfillment_id AND location_id = p_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  SELECT order_status INTO v_order_status FROM public.commerce_orders WHERE id = v_row.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking: order_missing'; END IF;
  SELECT * INTO v_row FROM public.fulfillments WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  IF v_row.status <> 'picking'
     OR (v_row.claimed_device_id IS NOT NULL
         AND v_row.claimed_device_id IS DISTINCT FROM p_device_id) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking';
  END IF;
  IF v_order_status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: order_cancelled';
  END IF;

  PERFORM fi.id FROM public.fulfillment_items fi
   WHERE fi.fulfillment_id = p_fulfillment_id ORDER BY fi.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking: items_empty'; END IF;
  PERFORM s.id FROM public.fulfillment_shortages s
   WHERE s.fulfillment_id = p_fulfillment_id ORDER BY s.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shortages
     WHERE fulfillment_id = p_fulfillment_id AND status = 'pending_customer'
  ) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: shortage_pending_customer_confirmation';
  END IF;
  v_block := public.commerce_order_settlement_block(v_row.order_id);
  IF v_block IN ('refund_blocked') THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: refund_pending';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.fulfillment_items fi
     WHERE fi.fulfillment_id = p_fulfillment_id
       AND fi.picked_qty < greatest(fi.expected_qty - public.commerce_item_cleared_shortage_qty(fi.id), 0)
  ) THEN
    RAISE EXCEPTION 'fulfillment still has unpicked items';
  END IF;

  UPDATE public.fulfillments SET status = 'picked', picked_at = now(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(
  p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid,
  p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text, p_carrier_label text)
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
REVOKE ALL ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text,text) TO service_role;
