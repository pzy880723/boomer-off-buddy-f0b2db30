-- 自动生成：现行函数定义快照，取自数据库当前定义（非迁移文件）。
CREATE OR REPLACE FUNCTION public.commerce_apply_ordinary_refund(p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.commerce_refunds; v_payment public.commerce_payments; v_event public.commerce_payment_events;
  v_payment_id uuid; v_order_id uuid; v_payment_refunds numeric; v_paid numeric; v_refunded numeric;
  v_count bigint; v_all boolean;
BEGIN
  SELECT payment_id,order_id INTO v_payment_id,v_order_id FROM public.commerce_refunds WHERE merchant_refund_no=p_event->>'merchant_refund_no';
  IF NOT FOUND THEN RAISE EXCEPTION 'ordinary refund not found'; END IF;
  PERFORM 1 FROM public.commerce_orders WHERE id=v_order_id FOR UPDATE;
  SELECT * INTO v_payment FROM public.commerce_payments WHERE id=v_payment_id FOR UPDATE;
  SELECT * INTO v FROM public.commerce_refunds WHERE merchant_refund_no=p_event->>'merchant_refund_no' FOR UPDATE;
  IF nullif(p_event->>'event_id','') IS NULL OR p_event->>'status' IS NULL
    OR p_event->>'status' NOT IN ('succeeded','failed','cancelled') OR nullif(p_event->>'provider_refund_id','') IS NULL
    OR p_event->>'merchant_id' IS DISTINCT FROM v.route_snapshot->>'merchant_id'
    OR p_event->>'transaction_id' IS DISTINCT FROM v_payment.provider_transaction_id
    OR (p_event->>'total_fen')::numeric IS DISTINCT FROM v_payment.amount*100
    OR (p_event->>'refund_fen')::numeric IS DISTINCT FROM v.amount*100
    OR (v.provider_refund_id IS NOT NULL AND v.provider_refund_id<>p_event->>'provider_refund_id') THEN
    RAISE EXCEPTION 'refund event snapshot mismatch'; END IF;
  INSERT INTO public.commerce_payment_events(payment_id,provider,provider_event_id,event_type,signature_verified,payload)
    VALUES(v_payment.id,'wechat',p_event->>'event_id','ordinary.refund.'||(p_event->>'status'),true,p_event)
    ON CONFLICT(provider,provider_event_id) DO NOTHING;
  SELECT * INTO v_event FROM public.commerce_payment_events WHERE provider='wechat' AND provider_event_id=p_event->>'event_id' FOR UPDATE;
  IF v_event.payment_id IS DISTINCT FROM v_payment.id OR v_event.payload IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'refund event replay mismatch'; END IF;
  IF v_event.processing_status='processed' THEN RETURN jsonb_build_object('refund',to_jsonb(v),'replayed',true); END IF;
  IF v.status<>'succeeded' THEN
    IF p_event->>'status'='succeeded' AND nullif(p_event->>'refunded_at','') IS NULL THEN RAISE EXCEPTION 'invalid refund success time'; END IF;
    UPDATE public.commerce_refunds SET status=p_event->>'status',provider_refund_id=p_event->>'provider_refund_id',
      refunded_at=CASE WHEN p_event->>'status'='succeeded' THEN (p_event->>'refunded_at')::timestamptz ELSE NULL END,
      lease_token=NULL WHERE id=v.id RETURNING * INTO v;
    IF v.status='succeeded' THEN
      SELECT coalesce(sum(amount),0) INTO v_payment_refunds FROM public.commerce_refunds WHERE payment_id=v.payment_id AND status='succeeded';
      IF v_payment_refunds>v_payment.amount THEN RAISE EXCEPTION 'refund amount exceeds payment limit'; END IF;
      UPDATE public.commerce_payments SET status=CASE WHEN v_payment_refunds=amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() WHERE id=v.payment_id;
      SELECT count(*),coalesce(sum(p.amount),0),
             coalesce(sum((SELECT coalesce(sum(r.amount),0) FROM public.commerce_refunds r WHERE r.payment_id=p.id AND r.status='succeeded')),0),
             coalesce(bool_and(p.status='refunded' AND p.amount=coalesce((SELECT sum(r.amount) FROM public.commerce_refunds r WHERE r.payment_id=p.id AND r.status='succeeded'),0)),false)
        INTO v_count,v_paid,v_refunded,v_all FROM public.commerce_payments p
       WHERE p.order_id=v.order_id AND p.status IN ('succeeded','partially_refunded','refunded');
      UPDATE public.commerce_orders o SET payment_status=CASE WHEN v_count>0 AND v_paid=o.total_amount AND v_refunded=v_paid AND v_all THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() WHERE o.id=v.order_id;
      UPDATE public.commerce_after_sales SET status='refunded',refunded_at=v.refunded_at,updated_at=now() WHERE id=v.after_sale_id;
      PERFORM public.commerce_close_order_if_fully_refunded(v.order_id,'full_refund_succeeded',jsonb_build_object(
        'refund_id',v.id,'payment_id',v.payment_id,'payment_succeeded_refund_total',v_payment_refunds,
        'order_successful_payment_total',v_paid,'order_succeeded_refund_total',v_refunded,'event_id',p_event->>'event_id'));
    END IF;
  END IF;
  UPDATE public.commerce_payment_events SET processing_status='processed',processed_at=now() WHERE id=v_event.id;
  RETURN jsonb_build_object('refund',to_jsonb(v),'replayed',false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.commerce_close_order_if_fully_refunded(p_order_id uuid, p_reason text, p_evidence jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_order public.commerce_orders; v_paid numeric; v_refunded numeric; v_count bigint; v_all boolean;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.payment_status<>'refunded' OR v_order.order_status IN ('closed','cancelled') THEN RETURN false; END IF;
  SELECT count(*),coalesce(sum(p.amount),0),
         coalesce(sum((SELECT coalesce(sum(r.amount),0) FROM public.commerce_refunds r WHERE r.payment_id=p.id AND r.status='succeeded')),0),
         coalesce(bool_and(p.status='refunded' AND p.amount=coalesce((SELECT sum(r.amount) FROM public.commerce_refunds r WHERE r.payment_id=p.id AND r.status='succeeded'),0)),false)
    INTO v_count,v_paid,v_refunded,v_all
    FROM public.commerce_payments p
   WHERE p.order_id=p_order_id AND p.status IN ('succeeded','partially_refunded','refunded');
  IF v_count=0 OR v_paid<>v_order.total_amount OR v_refunded<>v_paid OR NOT v_all THEN RETURN false; END IF;
  INSERT INTO public.commerce_order_status_audit(order_id,from_status,to_status,reason,evidence)
  VALUES(p_order_id,v_order.order_status,'closed',p_reason,coalesce(p_evidence,'{}'::jsonb)||jsonb_build_object(
    'previous_updated_at',v_order.updated_at,'order_total_amount',v_order.total_amount,
    'successful_payment_total',v_paid,'successful_refund_total',v_refunded));
  UPDATE public.commerce_orders SET order_status='closed',updated_at=now() WHERE id=p_order_id;
  RETURN true;
END $function$
;
CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text, p_carrier_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  f record; o record; s record; ln jsonb;
  v_ship uuid; v_tracking text := upper(btrim(coalesce(p_tracking_no,'')));
  v_label text := nullif(btrim(coalesce(p_carrier_label,'')), '');
  v_req jsonb := '{}'::jsonb;
  v_canon text; v_fp text; v_mismatch text;
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

  SELECT * INTO f FROM public.fulfillments WHERE id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','not_found'); END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_user_id AND role::text IN ('super_admin','hq_operator'))
       OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor_user_id AND role::text IN ('store_manager','store_staff','warehouse_staff'))
           AND EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor_user_id AND location_id = f.location_id))) THEN
    RETURN jsonb_build_object('ok',false,'result','forbidden');
  END IF;
  IF p_location_id IS NOT NULL AND p_location_id IS DISTINCT FROM f.location_id THEN
    RETURN jsonb_build_object('ok',false,'result','location_forbidden');
  END IF;

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

  SELECT * INTO o FROM public.commerce_orders WHERE id = f.order_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','not_found'); END IF;
  IF o.fulfillment_method = 'pickup' THEN RETURN jsonb_build_object('ok',false,'result','pickup_order'); END IF;
  IF o.payment_status IN ('refund_pending','partially_refunded','refunded') THEN RETURN jsonb_build_object('ok',false,'result','refund_blocked'); END IF;
  IF o.payment_status IS DISTINCT FROM 'paid' THEN RETURN jsonb_build_object('ok',false,'result','unpaid'); END IF;
  IF o.order_status IN ('cancelled','closed') THEN RETURN jsonb_build_object('ok',false,'result','cancelled'); END IF;
  IF o.order_status = 'after_sale' THEN RETURN jsonb_build_object('ok',false,'result','after_sale_blocked'); END IF;
  IF f.status IN ('handed_over','exception','unallocated') THEN RETURN jsonb_build_object('ok',false,'result','invalid_status'); END IF;

  PERFORM 1 FROM public.fulfillment_items WHERE fulfillment_id = f.id ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.fulfillment_shortages sh WHERE sh.fulfillment_id = f.id AND sh.status <> 'withdrawn'
              AND NOT (sh.status = 'customer_accepted' AND sh.refund_state IN ('refund_completed','not_required'))) THEN
    RETURN jsonb_build_object('ok',false,'result','shortage_blocked');
  END IF;

  WITH ship AS (
    SELECT it.id, greatest(0, it.expected_qty - coalesce((SELECT sum(sh.quantity) FROM public.fulfillment_shortages sh
             WHERE sh.fulfillment_item_id = it.id AND sh.status = 'customer_accepted'
               AND sh.refund_state IN ('refund_completed','not_required')),0))::int AS q
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
END $function$
;
CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.commerce_manual_ship_fulfillment(p_actor_user_id, p_location_id, p_fulfillment_id,
    p_provider, p_tracking_no, p_lines, p_idempotency_key, NULL::text)
$function$
;
CREATE OR REPLACE FUNCTION public.commerce_pickup_actor_can(p_actor uuid, p_location_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_actor IS NOT NULL AND p_location_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.inv_locations WHERE id = p_location_id AND kind = 'shop' AND is_active)
    AND (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('super_admin','hq_operator'))
      OR (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('store_manager','store_staff'))
          AND EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor AND location_id = p_location_id)))
$function$
;
CREATE OR REPLACE FUNCTION public.commerce_pickup_block_reason(p_order_id uuid, p_fulfillment_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.commerce_pickup_mark_ready(p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
END $function$
;
CREATE OR REPLACE FUNCTION public.commerce_pickup_redeem(p_actor_user_id uuid, p_location_id uuid, p_qr_payload text, p_code text, p_idempotency_key text, p_expected_fulfillment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION public.commerce_settle_refund_intent(p_intent_id uuid, p_lease_token uuid, p_state text, p_error text, p_refund_id uuid, p_retry_delay_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.fulfillment_complete_pick(p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid)
 RETURNS fulfillments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.fulfillments;
  v_order_status text;
BEGIN
  SELECT * INTO v_row FROM public.fulfillments
   WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  IF v_row.status <> 'picking'
     OR (v_row.claimed_device_id IS NOT NULL
         AND v_row.claimed_device_id IS DISTINCT FROM p_device_id) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking';
  END IF;

  SELECT order_status INTO v_order_status FROM public.commerce_orders
   WHERE id = v_row.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking: order_missing'; END IF;
  IF v_order_status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: order_cancelled';
  END IF;

  -- Lock the inputs before reading counts. The fulfillment lock also serializes
  -- pick scans and FK-backed child inserts; existing shortages can update independently.
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
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shortages
     WHERE fulfillment_id = p_fulfillment_id
       AND status <> 'withdrawn' AND refund_state = 'refund_pending'
  ) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: refund_pending';
  END IF;

  -- Customer acceptance alone never waives a whole line or an unsettled refund.
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_items fi
     WHERE fi.fulfillment_id = p_fulfillment_id
       AND fi.picked_qty < greatest(fi.expected_qty::bigint - coalesce((
         SELECT sum(s.quantity) FROM public.fulfillment_shortages s
          WHERE s.fulfillment_id = p_fulfillment_id
            AND s.fulfillment_item_id = fi.id
            AND s.status = 'customer_accepted'
            AND s.refund_state IN ('refund_completed', 'not_required')
       ), 0), 0)
  ) THEN
    RAISE EXCEPTION 'fulfillment still has unpicked items';
  END IF;

  UPDATE public.fulfillments SET status = 'picked', picked_at = now(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$
;
