-- Additive ordinary-merchant lane. Legacy orders, submerchant allocation and APIs remain intact.
ALTER TABLE public.commerce_orders ADD COLUMN payment_route jsonb;
ALTER TABLE public.commerce_payments
  ADD COLUMN payment_channel text NOT NULL DEFAULT 'legacy' CHECK (payment_channel IN ('legacy','ordinary_wechat')),
  ADD COLUMN merchant_order_no text UNIQUE,
  ADD COLUMN payer_openid text,
  ADD COLUMN prepay_id text,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN ordinary_checked_at timestamptz;
CREATE UNIQUE INDEX uniq_ordinary_payment_order ON public.commerce_payments(order_id)
  WHERE payment_channel = 'ordinary_wechat';
CREATE INDEX idx_ordinary_payments_recovery ON public.commerce_payments(ordinary_checked_at NULLS FIRST,created_at)
  WHERE payment_channel='ordinary_wechat' AND status IN ('pending','processing','failed');
ALTER TABLE public.commerce_refunds
  ADD COLUMN merchant_refund_no text UNIQUE,
  ADD COLUMN route_snapshot jsonb,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN ordinary_checked_at timestamptz;
CREATE UNIQUE INDEX uniq_ordinary_refund_after_sale ON public.commerce_refunds(after_sale_id)
  WHERE merchant_refund_no IS NOT NULL;
CREATE INDEX idx_ordinary_refunds_recovery ON public.commerce_refunds(ordinary_checked_at NULLS FIRST,created_at)
  WHERE merchant_refund_no IS NOT NULL AND status IN ('pending','processing','failed');

CREATE OR REPLACE FUNCTION public.commerce_ordinary_immutable_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'commerce_orders' THEN
    IF OLD.payment_route IS NOT NULL AND NEW.payment_route IS DISTINCT FROM OLD.payment_route THEN
      RAISE EXCEPTION 'payment route is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'commerce_payments' THEN
    IF OLD.payment_channel = 'ordinary_wechat' AND
      (NEW.order_id,NEW.payment_channel,NEW.merchant_order_no,NEW.payer_openid,NEW.merchant_snapshot,NEW.amount,NEW.currency)
      IS DISTINCT FROM
      (OLD.order_id,OLD.payment_channel,OLD.merchant_order_no,OLD.payer_openid,OLD.merchant_snapshot,OLD.amount,OLD.currency) THEN
      RAISE EXCEPTION 'payment snapshot is immutable';
    END IF;
  ELSE
    IF OLD.merchant_refund_no IS NOT NULL AND
      (NEW.order_id,NEW.payment_id,NEW.after_sale_id,NEW.merchant_refund_no,NEW.route_snapshot,NEW.amount)
      IS DISTINCT FROM
      (OLD.order_id,OLD.payment_id,OLD.after_sale_id,OLD.merchant_refund_no,OLD.route_snapshot,OLD.amount) THEN
      RAISE EXCEPTION 'refund snapshot is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ordinary_order_route_immutable BEFORE UPDATE ON public.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION public.commerce_ordinary_immutable_snapshot();
CREATE TRIGGER ordinary_payment_snapshot_immutable BEFORE UPDATE ON public.commerce_payments
  FOR EACH ROW EXECUTE FUNCTION public.commerce_ordinary_immutable_snapshot();
CREATE TRIGGER ordinary_refund_snapshot_immutable BEFORE UPDATE ON public.commerce_refunds
  FOR EACH ROW EXECUTE FUNCTION public.commerce_ordinary_immutable_snapshot();

CREATE OR REPLACE FUNCTION public.commerce_create_ordinary_order(
  p_customer_id uuid,p_idempotency_key text,p_items jsonb,p_recipient_name text,p_recipient_phone text,
  p_shipping_address jsonb,p_courier_provider text,p_courier_service_code text,p_courier_service_name text,
  p_shipping_fee numeric,p_quote_snapshot jsonb,p_customer_note text,p_merchant_id text,p_app_id text,
  p_owned_location_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.commerce_orders; v_listing record; v_locations jsonb;
BEGIN
  IF nullif(btrim(p_idempotency_key),'') IS NULL OR length(p_idempotency_key)>200
     OR p_customer_id IS NULL OR p_merchant_id !~ '^[0-9]{6,20}$' OR p_app_id !~ '^wx[a-zA-Z0-9]{16}$'
     OR p_merchant_id IS NULL OR p_app_id IS NULL OR coalesce(cardinality(p_owned_location_ids),0)=0 THEN
    RAISE EXCEPTION 'invalid ordinary order configuration';
  END IF;
  PERFORM 1 FROM public.commerce_customers WHERE id=p_customer_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active customer not found'; END IF;
  -- Serializes retries before the original create RPC, including first inserts.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || p_idempotency_key,0));
  SELECT * INTO v_order FROM public.commerce_orders
    WHERE customer_id=p_customer_id AND idempotency_key=p_idempotency_key AND source_channel='storefront' FOR UPDATE;
  IF FOUND THEN
    IF v_order.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat' THEN
      RAISE EXCEPTION 'legacy order route cannot be converted';
    END IF;
    RETURN to_jsonb(v_order);
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'ordinary order requires items';
  END IF;
  FOR v_listing IN
    SELECT l.id,l.location_id,l.sku_id FROM public.commerce_listings l
    WHERE l.id IN (SELECT (i->>'listing_id')::uuid FROM jsonb_array_elements(p_items) i)
    ORDER BY l.id FOR UPDATE
  LOOP
    IF NOT (v_listing.location_id=ANY(p_owned_location_ids)) OR NOT EXISTS (
      SELECT 1 FROM public.inv_locations WHERE id=v_listing.location_id AND is_active
    ) THEN RAISE EXCEPTION 'location is not an approved self-operated location'; END IF;
    PERFORM 1 FROM public.inv_skus WHERE id=v_listing.sku_id
      AND sale_ownership='owned' AND nullif(btrim(settlement_party_ref),'') IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SKU ownership is not self-operated';
    END IF;
  END LOOP;
  v_order := public.commerce_create_order_v2(p_customer_id,p_idempotency_key,p_items,p_recipient_name,
    p_recipient_phone,p_shipping_address,p_courier_provider,p_courier_service_code,p_courier_service_name,
    p_shipping_fee,p_quote_snapshot,p_customer_note);
  PERFORM 1 FROM public.inv_skus WHERE id IN(SELECT stock_sku_id FROM public.inventory_reservation_lines l
    JOIN public.commerce_order_items i ON i.id=l.order_item_id WHERE i.order_id=v_order.id) ORDER BY id FOR SHARE;
  -- Includes actual stock components of bundles, not merely the parent listing.
  IF EXISTS (SELECT 1 FROM public.inventory_reservation_lines l
    JOIN public.commerce_order_items i ON i.id=l.order_item_id
    JOIN public.inv_skus s ON s.id=l.stock_sku_id WHERE i.order_id=v_order.id
    AND (s.sale_ownership<>'owned' OR nullif(btrim(s.settlement_party_ref),'') IS NOT NULL)) THEN
    RAISE EXCEPTION 'bundle component ownership is not self-operated';
  END IF;
  SELECT jsonb_agg(DISTINCT location_id ORDER BY location_id) INTO v_locations
    FROM public.commerce_order_items WHERE order_id=v_order.id;
  UPDATE public.commerce_order_items SET ownership_snapshot='owned',
    settlement_snapshot=jsonb_build_object('mode','ordinary_wechat','merchant_id',p_merchant_id,
      'app_id',p_app_id,'location_id',location_id,'ownership','owned','line_total_fen',(line_total*100)::bigint)
    WHERE order_id=v_order.id;
  UPDATE public.commerce_orders SET payment_route=jsonb_build_object('version',1,'mode','ordinary_wechat',
    'merchant_id',p_merchant_id,'app_id',p_app_id,'customer_id',p_customer_id,'location_ids',v_locations,
    'currency',currency,'total_fen',(total_amount*100)::bigint)
    WHERE id=v_order.id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_ordinary_payment(
  p_order_id uuid,p_customer_id uuid,p_idempotency_key text,p_openid text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.commerce_orders; v_payment public.commerce_payments; v_token uuid;
BEGIN
  IF nullif(btrim(p_idempotency_key),'') IS NULL OR length(p_idempotency_key)>200
     OR nullif(btrim(p_openid),'') IS NULL OR length(p_openid)>200 THEN RAISE EXCEPTION 'invalid payment identity'; END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id AND customer_id=p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer order not found'; END IF;
  IF v_order.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat' THEN RAISE EXCEPTION 'not an ordinary order route'; END IF;
  SELECT * INTO v_payment FROM public.commerce_payments WHERE provider='wechat' AND idempotency_key=p_idempotency_key;
  IF FOUND AND (v_payment.order_id<>p_order_id OR v_payment.payment_channel<>'ordinary_wechat') THEN
    RAISE EXCEPTION 'payment idempotency key belongs to another intent';
  END IF;
  SELECT * INTO v_payment FROM public.commerce_payments WHERE order_id=p_order_id AND payment_channel='ordinary_wechat' FOR UPDATE;
  IF FOUND THEN
    IF v_payment.idempotency_key<>p_idempotency_key THEN RAISE EXCEPTION 'order already has another payment intent'; END IF;
    IF v_payment.payer_openid<>p_openid THEN RAISE EXCEPTION 'payer openid mismatch'; END IF;
    IF v_payment.status IN ('succeeded','partially_refunded','refunded','cancelled')
       OR v_payment.lease_expires_at>now() OR (v_payment.prepay_id IS NOT NULL AND v_payment.expires_at>now()) THEN
      RETURN jsonb_build_object('payment',to_jsonb(v_payment),'acquired',false,'lease_token',NULL);
    END IF;
  END IF;
  IF v_order.order_status<>'pending_payment' OR v_order.payment_status<>'unpaid'
     OR v_order.reservation_expires_at<=now() THEN RAISE EXCEPTION 'order is no longer payable'; END IF;
  IF v_order.currency<>'CNY' OR v_order.total_amount<=0 OR
    v_order.payment_route->>'total_fen' IS DISTINCT FROM ((v_order.total_amount*100)::bigint)::text THEN
    RAISE EXCEPTION 'order amount snapshot mismatch';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=p_order_id) OR EXISTS(
    SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=p_order_id AND NOT EXISTS(
      SELECT 1 FROM public.inventory_reservations r JOIN public.inventory_reservation_lines l ON l.reservation_id=r.id
      WHERE r.order_id=p_order_id AND l.order_item_id=i.id AND r.status='active' AND r.expires_at>now()
    )) THEN RAISE EXCEPTION 'order inventory reservation is incomplete'; END IF;
  v_token:=gen_random_uuid();
  IF v_payment.id IS NULL THEN
    INSERT INTO public.commerce_payments(order_id,provider,status,amount,currency,idempotency_key,
      payment_channel,merchant_order_no,payer_openid,merchant_snapshot,expires_at,lease_token,lease_expires_at)
    VALUES(p_order_id,'wechat','processing',v_order.total_amount,v_order.currency,p_idempotency_key,
      'ordinary_wechat',replace(gen_random_uuid()::text,'-',''),p_openid,v_order.payment_route,
      v_order.reservation_expires_at,v_token,now()+interval '2 minutes') RETURNING * INTO v_payment;
  ELSE
    UPDATE public.commerce_payments SET lease_token=v_token,lease_expires_at=now()+interval '2 minutes',updated_at=now()
      WHERE id=v_payment.id RETURNING * INTO v_payment;
  END IF;
  -- Unknown remote payment must keep stock unavailable to competing checkout RPCs.
  -- The original order deadline still governs WeChat time_expire and success_time.
  UPDATE public.inventory_reservations SET expires_at='infinity' WHERE order_id=p_order_id AND status='active';
  RETURN jsonb_build_object('payment',to_jsonb(v_payment),'acquired',true,'lease_token',v_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_record_ordinary_prepay(
  p_payment_id uuid,p_lease_token uuid,p_prepay_id text,p_payment_payload jsonb,p_expires_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.commerce_payments;
BEGIN
  SELECT * INTO v FROM public.commerce_payments WHERE id=p_payment_id AND payment_channel='ordinary_wechat' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ordinary payment not found'; END IF;
  IF v.status IN ('succeeded','partially_refunded','refunded','cancelled') THEN RETURN to_jsonb(v); END IF;
  IF v.lease_token IS DISTINCT FROM p_lease_token OR p_lease_token IS NULL THEN RAISE EXCEPTION 'payment lease mismatch'; END IF;
  IF nullif(btrim(p_prepay_id),'') IS NULL OR jsonb_typeof(p_payment_payload) IS DISTINCT FROM 'object'
     OR p_expires_at IS NULL OR p_expires_at>v.expires_at THEN RAISE EXCEPTION 'invalid prepay payload'; END IF;
  UPDATE public.commerce_payments SET prepay_id=p_prepay_id,payment_payload=p_payment_payload,
    lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=v.id RETURNING * INTO v;
  RETURN to_jsonb(v);
END;
$$;

-- Same inventory/fulfillment path as commerce_mark_order_paid, but ordinary success
-- is judged by signed payment time; its active reservations remain held until close.
CREATE OR REPLACE FUNCTION public.commerce_mark_ordinary_order_paid(
  p_order_id uuid,p_provider_transaction_id text,p_paid_at timestamptz
) RETURNS public.commerce_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order public.commerce_orders; v_line record; v_listing record; v_fulfillment_id uuid; v_stock integer;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=p_order_id FOR UPDATE;
  IF v_order.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat' OR NOT EXISTS(
    SELECT 1 FROM public.commerce_payments WHERE order_id=p_order_id AND payment_channel='ordinary_wechat'
      AND status='succeeded' AND provider_transaction_id=p_provider_transaction_id
  ) THEN RAISE EXCEPTION 'ordinary payment has not been verified'; END IF;
  IF v_order.payment_status='paid' AND v_order.provider_transaction_id=p_provider_transaction_id THEN RETURN v_order; END IF;
  IF v_order.order_status<>'pending_payment' OR v_order.payment_status<>'unpaid' OR p_paid_at IS NULL
     OR p_paid_at>v_order.reservation_expires_at OR p_paid_at<v_order.created_at-interval '5 minutes'
     OR p_paid_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'order payment time or state mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE order_id=p_order_id) OR EXISTS(
    SELECT 1 FROM public.commerce_order_items i WHERE i.order_id=p_order_id AND NOT EXISTS(
      SELECT 1 FROM public.inventory_reservations r JOIN public.inventory_reservation_lines l ON l.reservation_id=r.id
      WHERE r.order_id=p_order_id AND l.order_item_id=i.id AND r.status='active'
    )) THEN RAISE EXCEPTION 'order inventory reservation is incomplete'; END IF;
  FOR v_line IN SELECT l.*,i.epc,i.sku_id AS item_sku_id,i.id AS item_id
    FROM public.inventory_reservation_lines l
    JOIN public.inventory_reservations r ON r.id=l.reservation_id
    JOIN public.commerce_order_items i ON i.id=l.order_item_id
    WHERE r.order_id=p_order_id AND r.status='active' ORDER BY l.stock_sku_id,l.location_id
  LOOP
    SELECT qty INTO v_stock FROM public.inv_stocks WHERE sku_id=v_line.stock_sku_id AND location_id=v_line.location_id FOR UPDATE;
    IF coalesce(v_stock,0)<v_line.quantity THEN RAISE EXCEPTION 'paid order inventory unavailable'; END IF;
    PERFORM public.inv_apply_movement(v_line.stock_sku_id,v_line.location_id,-v_line.quantity,'commerce_sale',p_order_id,
      CASE WHEN v_line.stock_sku_id=v_line.item_sku_id THEN v_line.epc ELSE NULL END,p_provider_transaction_id);
    INSERT INTO public.fulfillments(order_id,location_id) VALUES(p_order_id,v_line.location_id)
      ON CONFLICT(order_id,location_id) DO UPDATE SET updated_at=now() RETURNING id INTO v_fulfillment_id;
    INSERT INTO public.fulfillment_items(fulfillment_id,order_item_id,sku_id,epc,expected_qty)
      VALUES(v_fulfillment_id,v_line.item_id,v_line.stock_sku_id,
        CASE WHEN v_line.stock_sku_id=v_line.item_sku_id THEN v_line.epc ELSE NULL END,v_line.quantity)
      ON CONFLICT(fulfillment_id,order_item_id,sku_id) DO NOTHING;
  END LOOP;
  UPDATE public.inventory_reservations SET status='consumed',consumed_at=p_paid_at WHERE order_id=p_order_id AND status='active';
  FOR v_listing IN SELECT l.id,l.product_type,i.epc FROM public.commerce_order_items i
    JOIN public.commerce_listings l ON l.id=i.listing_id WHERE i.order_id=p_order_id
  LOOP
    IF v_listing.product_type='custom' THEN
      UPDATE public.commerce_listings SET status='sold',sold_at=p_paid_at,updated_at=now() WHERE id=v_listing.id;
      IF v_listing.epc IS NOT NULL THEN UPDATE public.inv_epcs SET status='sold',current_location_id=NULL,last_seen_at=now()
        WHERE epc=v_listing.epc; END IF;
    END IF;
  END LOOP;
  UPDATE public.commerce_orders SET payment_status='paid',order_status='processing',provider_transaction_id=p_provider_transaction_id,
    paid_at=p_paid_at,updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  RETURN v_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_apply_ordinary_payment(p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.commerce_payments; v_order_id uuid; v_event public.commerce_payment_events;
BEGIN
  SELECT order_id INTO v_order_id FROM public.commerce_payments WHERE merchant_order_no=p_event->>'merchant_order_no' AND payment_channel='ordinary_wechat';
  IF NOT FOUND THEN RAISE EXCEPTION 'ordinary payment not found'; END IF;
  PERFORM 1 FROM public.commerce_orders WHERE id=v_order_id FOR UPDATE;
  SELECT * INTO v FROM public.commerce_payments WHERE merchant_order_no=p_event->>'merchant_order_no' FOR UPDATE;
  IF p_event->>'status' IS DISTINCT FROM 'succeeded' OR nullif(p_event->>'event_id','') IS NULL
    OR nullif(p_event->>'transaction_id','') IS NULL OR p_event->>'merchant_id' IS DISTINCT FROM v.merchant_snapshot->>'merchant_id'
    OR p_event->>'app_id' IS DISTINCT FROM v.merchant_snapshot->>'app_id' OR p_event->>'currency' IS DISTINCT FROM v.currency
    OR (p_event->>'total_fen')::numeric IS DISTINCT FROM v.amount*100 OR p_event->>'payer_openid' IS DISTINCT FROM v.payer_openid THEN
    RAISE EXCEPTION 'payment event snapshot mismatch';
  END IF;
  INSERT INTO public.commerce_payment_events(payment_id,provider,provider_event_id,event_type,signature_verified,payload)
    VALUES(v.id,'wechat',p_event->>'event_id','ordinary.payment.succeeded',true,p_event)
    ON CONFLICT(provider,provider_event_id) DO NOTHING;
  SELECT * INTO v_event FROM public.commerce_payment_events WHERE provider='wechat' AND provider_event_id=p_event->>'event_id' FOR UPDATE;
  IF v_event.payment_id IS DISTINCT FROM v.id OR v_event.payload IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'payment event replay mismatch'; END IF;
  IF v_event.processing_status='processed' THEN RETURN jsonb_build_object('payment',to_jsonb(v),'replayed',true); END IF;
  IF v.status IN ('succeeded','partially_refunded','refunded') THEN
    IF v.provider_transaction_id IS DISTINCT FROM p_event->>'transaction_id' THEN RAISE EXCEPTION 'transaction mismatch'; END IF;
  ELSE
    IF v.status='cancelled' THEN RAISE EXCEPTION 'confirmed closed payment cannot succeed'; END IF;
    UPDATE public.commerce_payments SET status='succeeded',provider_transaction_id=p_event->>'transaction_id',
      paid_at=(p_event->>'paid_at')::timestamptz,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE id=v.id RETURNING * INTO v;
    PERFORM public.commerce_mark_ordinary_order_paid(v.order_id,v.provider_transaction_id,v.paid_at);
  END IF;
  UPDATE public.commerce_payment_events SET processing_status='processed',processed_at=now() WHERE id=v_event.id;
  RETURN jsonb_build_object('payment',to_jsonb(v),'replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_close_ordinary_payment(p_payment_id uuid,p_close_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.commerce_payments; v_order_id uuid; v_order public.commerce_orders; v_checked_at timestamptz;
BEGIN
  SELECT order_id INTO v_order_id FROM public.commerce_payments WHERE id=p_payment_id AND payment_channel='ordinary_wechat';
  IF NOT FOUND THEN RAISE EXCEPTION 'ordinary payment not found'; END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id=v_order_id FOR UPDATE;
  SELECT * INTO v FROM public.commerce_payments WHERE id=p_payment_id FOR UPDATE;
  IF p_close_evidence->>'merchant_order_no' IS DISTINCT FROM v.merchant_order_no
    OR p_close_evidence->>'merchant_id' IS DISTINCT FROM v.merchant_snapshot->>'merchant_id' THEN RAISE EXCEPTION 'close evidence mismatch'; END IF;
  IF p_close_evidence->>'status'='NOT_FOUND' THEN
    -- The trusted server may provide this only after a signature-verified
    -- ORDERNOTEXIST query, not from empty bodies, timeouts or a client request.
    -- Every create uses the original deadline; the extra lease-length grace
    -- prevents an old worker from creating a still-payable order after release.
    v_checked_at:=(p_close_evidence->>'checked_at')::timestamptz;
    IF v.prepay_id IS NOT NULL OR v_order.reservation_expires_at>now()-interval '2 minutes'
      OR v.lease_expires_at>now() OR v_checked_at IS NULL OR v_checked_at>now()
      OR v_checked_at<now()-interval '30 seconds' THEN RAISE EXCEPTION 'NOT_FOUND close evidence is not safe'; END IF;
  ELSIF p_close_evidence->>'status' IS DISTINCT FROM 'CLOSED' THEN RAISE EXCEPTION 'close evidence mismatch'; END IF;
  IF v.status IN ('succeeded','partially_refunded','refunded') THEN RAISE EXCEPTION 'paid payment cannot close'; END IF;
  UPDATE public.commerce_payments SET status='cancelled',lease_token=NULL,lease_expires_at=NULL,
    failure_code=CASE WHEN p_close_evidence->>'status'='NOT_FOUND' THEN 'verified_not_found_after_expiry' ELSE failure_code END,
    updated_at=now()
    WHERE id=v.id RETURNING * INTO v;
  UPDATE public.commerce_listings SET status='published',updated_at=now() WHERE status='reserved' AND id IN(
    SELECT listing_id FROM public.inventory_reservations WHERE order_id=v.order_id AND status='active');
  UPDATE public.inventory_reservations SET status='released',released_at=now() WHERE order_id=v.order_id AND status='active';
  UPDATE public.commerce_orders SET order_status='cancelled',cancelled_at=now(),updated_at=now()
    WHERE id=v.order_id AND payment_status='unpaid';
  RETURN to_jsonb(v);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_release_expired_reservations()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_order public.commerce_orders; v_count integer:=0;
BEGIN
  -- Preserve the legacy lane's two independent clocks and state predicates:
  -- reservation expiry releases even an already-cancelled unpaid order, while
  -- the order deadline cancels only pending orders, not unexpired reservations.
  WITH expired AS (
    UPDATE public.inventory_reservations r SET status='expired',released_at=now()
      FROM public.commerce_orders o WHERE r.order_id=o.id AND r.status='active'
        AND r.expires_at<=now() AND o.payment_status='unpaid'
        AND o.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat'
      RETURNING r.listing_id,r.order_id
  ), restored AS (
    UPDATE public.commerce_listings l SET status='published',updated_at=now()
      FROM expired e WHERE l.id=e.listing_id AND l.status='reserved' RETURNING l.id
  ), closed AS (
    UPDATE public.commerce_orders o SET order_status='cancelled',cancelled_at=now(),updated_at=now()
      WHERE o.payment_status='unpaid' AND o.order_status='pending_payment' AND o.reservation_expires_at<=now()
        AND o.payment_route->>'mode' IS DISTINCT FROM 'ordinary_wechat'
      RETURNING o.id
  ) SELECT count(*) INTO v_count FROM closed;

  FOR v_order IN SELECT * FROM public.commerce_orders WHERE payment_status='unpaid'
    AND order_status='pending_payment' AND reservation_expires_at<=now()
    AND payment_route->>'mode'='ordinary_wechat' ORDER BY id FOR UPDATE SKIP LOCKED
  LOOP
    IF EXISTS(SELECT 1 FROM public.commerce_payments WHERE order_id=v_order.id
      AND payment_channel='ordinary_wechat' AND status<>'cancelled') THEN CONTINUE; END IF;
    UPDATE public.commerce_listings SET status='published',updated_at=now() WHERE status='reserved' AND id IN(
      SELECT listing_id FROM public.inventory_reservations WHERE order_id=v_order.id AND status='active');
    UPDATE public.inventory_reservations SET status='expired',released_at=now() WHERE order_id=v_order.id AND status='active';
    UPDATE public.commerce_orders SET order_status='cancelled',cancelled_at=now(),updated_at=now() WHERE id=v_order.id;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_prepare_ordinary_refund(
  p_payment_id uuid,p_after_sale_id uuid,p_idempotency_key text,p_operator_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_payment public.commerce_payments; v_sale public.commerce_after_sales; v public.commerce_refunds;
  v_reserved numeric; v_token uuid; v_order_id uuid;
BEGIN
  IF nullif(btrim(p_idempotency_key),'') IS NULL OR length(p_idempotency_key)>200 OR p_operator_id IS NULL THEN
    RAISE EXCEPTION 'invalid refund request'; END IF;
  SELECT order_id INTO v_order_id FROM public.commerce_payments WHERE id=p_payment_id AND payment_channel='ordinary_wechat';
  IF NOT FOUND THEN RAISE EXCEPTION 'payment not refundable'; END IF;
  PERFORM 1 FROM public.commerce_orders WHERE id=v_order_id FOR UPDATE;
  SELECT * INTO v_payment FROM public.commerce_payments WHERE id=p_payment_id AND payment_channel='ordinary_wechat' FOR UPDATE;
  IF NOT FOUND OR v_payment.status NOT IN ('succeeded','partially_refunded','refunded') THEN RAISE EXCEPTION 'payment not refundable'; END IF;
  SELECT * INTO v FROM public.commerce_refunds WHERE idempotency_key=p_idempotency_key;
  IF FOUND AND (v.payment_id<>p_payment_id OR v.after_sale_id IS DISTINCT FROM p_after_sale_id OR v.merchant_refund_no IS NULL) THEN
    RAISE EXCEPTION 'refund idempotency mismatch'; END IF;
  SELECT * INTO v FROM public.commerce_refunds WHERE after_sale_id=p_after_sale_id AND merchant_refund_no IS NOT NULL FOR UPDATE;
  IF FOUND THEN
    IF v.payment_id<>p_payment_id OR v.idempotency_key<>p_idempotency_key THEN RAISE EXCEPTION 'after-sale already has a refund intent'; END IF;
    IF v.status IN ('succeeded','cancelled','failed') OR v.lease_expires_at>now() THEN
      RETURN jsonb_build_object('refund',to_jsonb(v),'payment',to_jsonb(v_payment),'acquired',false,'lease_token',NULL);
    END IF;
  ELSE
    SELECT * INTO v_sale FROM public.commerce_after_sales WHERE id=p_after_sale_id AND order_id=v_payment.order_id FOR UPDATE;
    IF NOT FOUND OR v_sale.status<>'refund_pending' OR v_sale.approved_amount IS NULL
      OR v_sale.approved_amount<=0 OR v_sale.approved_amount>v_sale.requested_amount THEN RAISE EXCEPTION 'refund not approved'; END IF;
    SELECT coalesce(sum(amount),0) INTO v_reserved FROM public.commerce_refunds
      WHERE payment_id=p_payment_id AND status<>'cancelled'; -- ABNORMAL/failed remains reserved until investigated.
    IF v_reserved+v_sale.approved_amount>v_payment.amount THEN RAISE EXCEPTION 'refund amount exceeds payment limit'; END IF;
    INSERT INTO public.commerce_refunds(order_id,payment_id,after_sale_id,provider,status,amount,reason,idempotency_key,
      requested_by,merchant_refund_no,route_snapshot)
      VALUES(v_payment.order_id,p_payment_id,p_after_sale_id,'wechat','processing',v_sale.approved_amount,
        v_sale.reason_code,p_idempotency_key,p_operator_id,replace(gen_random_uuid()::text,'-',''),v_payment.merchant_snapshot)
      RETURNING * INTO v;
  END IF;
  v_token:=gen_random_uuid();
  UPDATE public.commerce_refunds SET lease_token=v_token,lease_expires_at=now()+interval '2 minutes',updated_at=now()
    WHERE id=v.id RETURNING * INTO v;
  RETURN jsonb_build_object('refund',to_jsonb(v),'payment',to_jsonb(v_payment),'acquired',true,'lease_token',v_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_record_ordinary_refund(p_refund_id uuid,p_lease_token uuid,p_provider_refund_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.commerce_refunds;
BEGIN
  SELECT * INTO v FROM public.commerce_refunds WHERE id=p_refund_id AND merchant_refund_no IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ordinary refund not found'; END IF;
  IF v.status IN ('succeeded','failed','cancelled') THEN RETURN to_jsonb(v); END IF;
  IF p_lease_token IS NULL OR p_lease_token IS DISTINCT FROM v.lease_token OR nullif(p_provider_refund_id,'') IS NULL THEN
    RAISE EXCEPTION 'refund lease or provider identity mismatch'; END IF;
  IF v.provider_refund_id IS NOT NULL AND v.provider_refund_id<>p_provider_refund_id THEN RAISE EXCEPTION 'provider refund identity mismatch'; END IF;
  UPDATE public.commerce_refunds SET provider_refund_id=p_provider_refund_id,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE id=v.id RETURNING * INTO v;
  RETURN to_jsonb(v);
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_apply_ordinary_refund(p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v public.commerce_refunds; v_payment public.commerce_payments; v_event public.commerce_payment_events;
  v_payment_id uuid; v_sum numeric; v_order_id uuid;
BEGIN
  SELECT payment_id,order_id INTO v_payment_id,v_order_id FROM public.commerce_refunds
    WHERE merchant_refund_no=p_event->>'merchant_refund_no';
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
      lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=v.id RETURNING * INTO v;
    IF v.status='succeeded' THEN
      SELECT coalesce(sum(amount),0) INTO v_sum FROM public.commerce_refunds WHERE payment_id=v.payment_id AND status='succeeded';
      IF v_sum>v_payment.amount THEN RAISE EXCEPTION 'refund amount exceeds payment limit'; END IF;
      UPDATE public.commerce_payments SET status=CASE WHEN v_sum=amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() WHERE id=v.payment_id;
      UPDATE public.commerce_orders SET payment_status=CASE WHEN v_sum=total_amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() WHERE id=v.order_id;
      UPDATE public.commerce_after_sales SET status='refunded',refunded_at=v.refunded_at,updated_at=now() WHERE id=v.after_sale_id;
    END IF;
  END IF;
  UPDATE public.commerce_payment_events SET processing_status='processed',processed_at=now() WHERE id=v_event.id;
  RETURN jsonb_build_object('refund',to_jsonb(v),'replayed',false);
END;
$$;

-- All entry points receive identities/events from trusted server validation, never client RPC access.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('commerce_ordinary_immutable_snapshot','commerce_create_ordinary_order',
      'commerce_prepare_ordinary_payment','commerce_record_ordinary_prepay','commerce_mark_ordinary_order_paid',
      'commerce_apply_ordinary_payment','commerce_close_ordinary_payment','commerce_prepare_ordinary_refund',
      'commerce_record_ordinary_refund','commerce_apply_ordinary_refund','commerce_release_expired_reservations')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END; $$;
