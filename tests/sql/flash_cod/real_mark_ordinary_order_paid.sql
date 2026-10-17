CREATE OR REPLACE FUNCTION public.commerce_mark_ordinary_order_paid(p_order_id uuid, p_provider_transaction_id text, p_paid_at timestamp with time zone)
 RETURNS commerce_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$

