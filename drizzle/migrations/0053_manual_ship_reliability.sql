-- 手工发货可靠性 v2：全量预校验后再写（无部分写入）、整单明细完整性、缺货规则、内容指纹幂等、
-- 拣货与出库分离（已拣不重复累加）、manual + carrier_label 承运商合同（不把中通等映射为菜鸟）。
-- 回滚（按序）：
--   CREATE OR REPLACE 0050 原 7 参函数体（drizzle/migrations/0050_manual_ship_fulfillment.sql 原样重放）；
--   DROP FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text,text);
--   先确认无 provider='manual' 行，再 ALTER TABLE public.shipments DROP CONSTRAINT shipments_provider_check,
--     ADD CONSTRAINT shipments_provider_check CHECK (provider = ANY (ARRAY['sf','cainiao']));
--   ALTER TABLE public.shipments DROP CONSTRAINT shipments_manual_label_check, DROP COLUMN carrier_label, DROP COLUMN request_fingerprint;
ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS carrier_label text;
ALTER TABLE public.shipments ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.shipments DROP CONSTRAINT IF EXISTS shipments_provider_check;
ALTER TABLE public.shipments ADD CONSTRAINT shipments_provider_check CHECK (provider = ANY (ARRAY['sf','cainiao','manual']));
ALTER TABLE public.shipments DROP CONSTRAINT IF EXISTS shipments_manual_label_check;
ALTER TABLE public.shipments ADD CONSTRAINT shipments_manual_label_check
  CHECK (provider <> 'manual' OR (carrier_label IS NOT NULL AND char_length(carrier_label) BETWEEN 1 AND 40));
COMMENT ON COLUMN public.shipments.carrier_label IS '展示用承运商名称。provider=manual 时必填（如 中通快递），仅手工登记单号，不代表已对接电子面单。';

CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(
  p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid,
  p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text, p_carrier_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;
REVOKE ALL ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(
  p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid,
  p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.commerce_manual_ship_fulfillment(p_actor_user_id, p_location_id, p_fulfillment_id,
    p_provider, p_tracking_no, p_lines, p_idempotency_key, NULL::text)
$$;
REVOKE ALL ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text) TO service_role;
