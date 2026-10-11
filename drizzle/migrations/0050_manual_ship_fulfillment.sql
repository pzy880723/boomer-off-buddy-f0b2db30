-- 手工录快递单号：单事务、行锁、门店鉴权、付款/售后/自提校验、client_op_id 幂等。网页与手持共用。
-- 回滚：DROP FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text);
CREATE OR REPLACE FUNCTION public.commerce_manual_ship_fulfillment(
  p_actor_user_id uuid, p_location_id uuid, p_fulfillment_id uuid,
  p_provider text, p_tracking_no text, p_lines jsonb, p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  f record; o record; s record; ln jsonb; it record; v_ship uuid; v_tracking text := btrim(coalesce(p_tracking_no,''));
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('sf','cainiao') THEN RETURN jsonb_build_object('ok',false,'result','invalid_provider'); END IF;
  IF v_tracking !~ '^[A-Za-z0-9-]{4,64}$' THEN RETURN jsonb_build_object('ok',false,'result','invalid_tracking_no'); END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{6,80}$' THEN RETURN jsonb_build_object('ok',false,'result','invalid_idempotency_key'); END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN RETURN jsonb_build_object('ok',false,'result','invalid_lines'); END IF;

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
    IF s.fulfillment_id = f.id AND s.provider = p_provider AND s.tracking_no = v_tracking THEN
      RETURN jsonb_build_object('ok',true,'result','shipped','replayed',true,'shipment_id',s.id,'fulfillment_id',f.id,'provider',s.provider,'tracking_no',s.tracking_no);
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

  FOR ln IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (ln->>'fulfillment_item_id') IS NULL OR (ln->>'quantity') !~ '^[1-9][0-9]{0,4}$' THEN
      RETURN jsonb_build_object('ok',false,'result','invalid_lines');
    END IF;
    SELECT * INTO it FROM public.fulfillment_items
     WHERE id = (ln->>'fulfillment_item_id')::uuid AND fulfillment_id = f.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'result','invalid_lines'); END IF;
    IF (ln->>'quantity')::int > coalesce(it.expected_qty,0) - coalesce(it.picked_qty,0) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'qty_exceeded';
    END IF;
    UPDATE public.fulfillment_items SET picked_qty = coalesce(picked_qty,0) + (ln->>'quantity')::int, picked_at = now() WHERE id = it.id;
  END LOOP;

  INSERT INTO public.shipments (fulfillment_id, provider, status, tracking_no, idempotency_key, booked_at)
  VALUES (f.id, p_provider, 'booked', v_tracking, p_idempotency_key, now()) RETURNING id INTO v_ship;
  UPDATE public.fulfillments SET status = 'handed_over', handed_over_at = now() WHERE id = f.id;
  RETURN jsonb_build_object('ok',true,'result','shipped','replayed',false,'shipment_id',v_ship,'fulfillment_id',f.id,'provider',p_provider,'tracking_no',v_tracking);
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM = 'qty_exceeded' THEN RETURN jsonb_build_object('ok',false,'result','qty_exceeded'); END IF;
    RAISE;
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok',false,'result','already_shipped');
END $$;
REVOKE ALL ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_manual_ship_fulfillment(uuid,uuid,uuid,text,text,jsonb,text) TO service_role;