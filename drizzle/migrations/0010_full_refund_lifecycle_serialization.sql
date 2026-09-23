CREATE OR REPLACE FUNCTION public.commerce_close_order_if_fully_refunded(p_order_id uuid,p_reason text,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
END $$;
REVOKE ALL ON FUNCTION public.commerce_close_order_if_fully_refunded(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_close_order_if_fully_refunded(uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_apply_ordinary_refund(p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.commerce_order_is_refund_closed(p_order_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_blocked boolean;
BEGIN
  SELECT payment_status='refunded' OR order_status='closed' INTO v_blocked FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  RETURN coalesce(v_blocked,false);
END $$;
REVOKE ALL ON FUNCTION public.commerce_order_is_refund_closed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_order_is_refund_closed(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_fulfillment_block_refunded()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'exception' AND public.commerce_order_is_refund_closed(NEW.order_id) THEN
    RAISE EXCEPTION 'fulfillment blocked: order_refunded';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.tg_fulfillment_child_block_refunded()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_order uuid;
BEGIN
  IF TG_TABLE_NAME='fulfillment_items' THEN
    IF NEW.picked_qty<=OLD.picked_qty THEN RETURN NEW; END IF;
    SELECT order_id INTO v_order FROM public.fulfillments WHERE id=NEW.fulfillment_id;
  ELSIF TG_TABLE_NAME='shipments' THEN
    SELECT order_id INTO v_order FROM public.fulfillments WHERE id=NEW.fulfillment_id;
  ELSE
    RAISE EXCEPTION 'unsupported fulfillment child table';
  END IF;
  IF public.commerce_order_is_refund_closed(v_order) THEN RAISE EXCEPTION 'fulfillment blocked: order_refunded'; END IF;
  RETURN NEW;
END $$;