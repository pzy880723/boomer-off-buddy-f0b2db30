CREATE OR REPLACE FUNCTION public.commerce_create_order_v2(p_user_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text, p_shipping_address jsonb, p_courier_provider text, p_courier_service_code text, p_courier_service_name text DEFAULT NULL::text, p_shipping_fee numeric DEFAULT 0, p_quote_snapshot jsonb DEFAULT NULL::jsonb, p_customer_note text DEFAULT NULL::text)
 RETURNS commerce_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.commerce_orders;
  v_listing public.commerce_listings;
  v_sku public.inv_skus;
  v_request record;
  v_component record;
  v_order_item_id uuid;
  v_reservation_id uuid;
  v_stock integer;
  v_reserved integer;
  v_required integer;
  v_subtotal numeric := 0;
  v_expires_at timestamptz := now() + interval '15 minutes';
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'storefront user is required'; END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'order requires at least one item';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN RAISE EXCEPTION 'order has too many items'; END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_items) AS item(listing_id uuid, quantity integer)
     WHERE item.listing_id IS NULL OR item.quantity IS NULL OR item.quantity < 1 OR item.quantity > 999
  ) THEN
    RAISE EXCEPTION 'order item quantity is invalid';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_to_recordset(p_items) AS item(listing_id uuid, quantity integer)
  ) <> (
    SELECT count(DISTINCT item.listing_id)
      FROM jsonb_to_recordset(p_items) AS item(listing_id uuid, quantity integer)
  ) THEN
    RAISE EXCEPTION 'order contains duplicate listings';
  END IF;
  IF p_courier_provider NOT IN ('sf','cainiao','platform')
     AND NOT (p_courier_provider = 'flash' AND p_courier_service_code = 'SHANSONG_COD' AND p_shipping_fee = 0) THEN
    RAISE EXCEPTION 'unsupported courier provider';
  END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE user_id = p_user_id
     AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_order; END IF;

  INSERT INTO public.commerce_orders (
    user_id, idempotency_key, source_channel, fulfillment_method,
    recipient_name, recipient_phone, shipping_address,
    courier_provider, courier_service_code, courier_service_name,
    shipping_fee, courier_quote_snapshot, customer_note, reservation_expires_at
  ) VALUES (
    p_user_id, p_idempotency_key, 'storefront', 'shipping',
    p_recipient_name, p_recipient_phone, p_shipping_address,
    p_courier_provider, p_courier_service_code, p_courier_service_name,
    greatest(p_shipping_fee, 0), p_quote_snapshot, p_customer_note, v_expires_at
  ) ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING * INTO v_order;

  IF NOT FOUND THEN
    SELECT * INTO v_order
      FROM public.commerce_orders
     WHERE user_id = p_user_id
       AND idempotency_key = p_idempotency_key;
    RETURN v_order;
  END IF;

  FOR v_request IN
    SELECT item.listing_id, item.quantity
      FROM jsonb_to_recordset(p_items) AS item(listing_id uuid, quantity integer)
      ORDER BY item.listing_id
  LOOP
    SELECT * INTO v_listing
      FROM public.commerce_listings
     WHERE id = v_request.listing_id
     FOR UPDATE;
    IF NOT FOUND OR v_listing.status <> 'published' THEN
      RAISE EXCEPTION 'listing % is not available', v_request.listing_id;
    END IF;

    SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_listing.sku_id;
    IF NOT FOUND OR v_sku.status <> 'active' OR NOT v_sku.is_display THEN
      RAISE EXCEPTION 'listing % SKU is not sellable', v_listing.id;
    END IF;
    IF v_listing.product_type = 'custom' AND v_request.quantity <> 1 THEN
      RAISE EXCEPTION 'custom listing quantity must be one';
    END IF;

    INSERT INTO public.commerce_order_items (
      order_id, listing_id, sku_id, location_id, epc, title_snapshot,
      image_snapshot, condition_snapshot, unit_price, quantity, line_total
    ) VALUES (
      v_order.id, v_listing.id, v_listing.sku_id, v_listing.location_id, v_listing.epc,
      v_listing.title, v_listing.cover_url, v_listing.condition_grade, v_listing.price,
      v_request.quantity, v_listing.price * v_request.quantity
    ) RETURNING id INTO v_order_item_id;

    INSERT INTO public.inventory_reservations (
      order_id, listing_id, sku_id, location_id, quantity, expires_at
    ) VALUES (
      v_order.id, v_listing.id, v_listing.sku_id, v_listing.location_id,
      v_request.quantity, v_expires_at
    ) RETURNING id INTO v_reservation_id;

    IF v_listing.product_type = 'bundle' THEN
      IF jsonb_typeof(v_sku.bundle_items) <> 'array' OR jsonb_array_length(v_sku.bundle_items) = 0 THEN
        RAISE EXCEPTION 'bundle listing % has no components', v_listing.id;
      END IF;
      FOR v_component IN
        SELECT component.sku_id, component.qty
          FROM jsonb_to_recordset(v_sku.bundle_items) AS component(sku_id uuid, qty integer)
         ORDER BY component.sku_id
      LOOP
        v_required := v_request.quantity * v_component.qty;
        SELECT qty INTO v_stock
          FROM public.inv_stocks
         WHERE sku_id = v_component.sku_id
           AND location_id = v_listing.location_id
         FOR UPDATE;
        SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
          FROM public.inventory_reservation_lines line
          JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
         WHERE line.stock_sku_id = v_component.sku_id
           AND line.location_id = v_listing.location_id
           AND reservation.status = 'active'
           AND reservation.expires_at > now();
        IF coalesce(v_stock, 0) - v_reserved < v_required THEN
          RAISE EXCEPTION 'bundle component % is out of stock', v_component.sku_id;
        END IF;
        INSERT INTO public.inventory_reservation_lines (
          reservation_id, order_item_id, stock_sku_id, location_id, quantity
        ) VALUES (
          v_reservation_id, v_order_item_id, v_component.sku_id, v_listing.location_id, v_required
        );
      END LOOP;
    ELSE
      v_required := v_request.quantity;
      SELECT qty INTO v_stock
        FROM public.inv_stocks
       WHERE sku_id = v_listing.sku_id
         AND location_id = v_listing.location_id
       FOR UPDATE;
      SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
        FROM public.inventory_reservation_lines line
        JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
       WHERE line.stock_sku_id = v_listing.sku_id
         AND line.location_id = v_listing.location_id
         AND reservation.status = 'active'
         AND reservation.expires_at > now();
      IF coalesce(v_stock, 0) - v_reserved < v_required THEN
        RAISE EXCEPTION 'listing % is out of stock', v_listing.id;
      END IF;
      INSERT INTO public.inventory_reservation_lines (
        reservation_id, order_item_id, stock_sku_id, location_id, quantity
      ) VALUES (
        v_reservation_id, v_order_item_id, v_listing.sku_id, v_listing.location_id, v_required
      );
    END IF;

    IF v_listing.product_type = 'custom' THEN
      UPDATE public.commerce_listings
         SET status = 'reserved', updated_at = now()
       WHERE id = v_listing.id;
    END IF;
    v_subtotal := v_subtotal + v_listing.price * v_request.quantity;
  END LOOP;

  UPDATE public.commerce_orders
     SET subtotal = v_subtotal,
         total_amount = v_subtotal + greatest(p_shipping_fee, 0),
         updated_at = now()
   WHERE id = v_order.id
  RETURNING * INTO v_order;
  RETURN v_order;
END;
$function$