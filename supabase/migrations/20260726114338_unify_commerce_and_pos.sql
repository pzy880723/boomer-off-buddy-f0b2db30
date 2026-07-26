-- Unify the self-operated storefront and store POS on one sales ledger.
-- Existing storefront RPC signatures remain available as compatibility wrappers.

ALTER TABLE public.commerce_listings
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'custom';

UPDATE public.commerce_listings listing
   SET product_type = CASE
     WHEN sku.kind = 'bundle' THEN 'bundle'
     WHEN sku.is_custom_price THEN 'custom'
     ELSE 'standard'
   END
  FROM public.inv_skus sku
 WHERE sku.id = listing.sku_id;

ALTER TABLE public.commerce_listings
  DROP CONSTRAINT IF EXISTS commerce_listings_product_type_check;
ALTER TABLE public.commerce_listings
  ADD CONSTRAINT commerce_listings_product_type_check
  CHECK (product_type IN ('custom', 'standard', 'bundle'));

ALTER TABLE public.commerce_orders
  ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'storefront',
  ADD COLUMN IF NOT EXISTS fulfillment_method text NOT NULL DEFAULT 'shipping',
  ADD COLUMN IF NOT EXISTS sale_location_id uuid REFERENCES public.inv_locations(id),
  ADD COLUMN IF NOT EXISTS operator_id uuid,
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.commerce_orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.commerce_orders ALTER COLUMN recipient_name DROP NOT NULL;
ALTER TABLE public.commerce_orders ALTER COLUMN recipient_phone DROP NOT NULL;
ALTER TABLE public.commerce_orders ALTER COLUMN shipping_address DROP NOT NULL;
ALTER TABLE public.commerce_orders ALTER COLUMN courier_provider DROP NOT NULL;
ALTER TABLE public.commerce_orders ALTER COLUMN courier_service_code DROP NOT NULL;

ALTER TABLE public.commerce_orders
  DROP CONSTRAINT IF EXISTS commerce_orders_source_channel_check;
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_source_channel_check
  CHECK (source_channel IN ('storefront', 'pos', 'youzan', 'manual'));
ALTER TABLE public.commerce_orders
  DROP CONSTRAINT IF EXISTS commerce_orders_fulfillment_method_check;
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_fulfillment_method_check
  CHECK (fulfillment_method IN ('shipping', 'pickup', 'carryout'));

CREATE UNIQUE INDEX IF NOT EXISTS uniq_pos_order_client_op
  ON public.commerce_orders(idempotency_key)
  WHERE source_channel = 'pos';
CREATE INDEX IF NOT EXISTS idx_commerce_orders_source_created
  ON public.commerce_orders(source_channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_sale_location
  ON public.commerce_orders(sale_location_id, created_at DESC);

ALTER TABLE public.commerce_order_items
  DROP CONSTRAINT IF EXISTS commerce_order_items_quantity_check;
ALTER TABLE public.commerce_order_items ALTER COLUMN listing_id DROP NOT NULL;
ALTER TABLE public.commerce_order_items
  ADD CONSTRAINT commerce_order_items_quantity_check CHECK (quantity > 0);

ALTER TABLE public.inventory_reservations
  ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE public.inventory_reservations
  DROP CONSTRAINT IF EXISTS inventory_reservations_quantity_check;
ALTER TABLE public.inventory_reservations
  ADD CONSTRAINT inventory_reservations_quantity_check CHECK (quantity > 0);
DROP INDEX IF EXISTS public.uniq_active_listing_reservation;

CREATE TABLE public.inventory_reservation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.inventory_reservations(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.commerce_order_items(id) ON DELETE CASCADE,
  stock_sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, stock_sku_id)
);
CREATE INDEX idx_inventory_reservation_lines_stock
  ON public.inventory_reservation_lines(stock_sku_id, location_id);
ALTER TABLE public.inventory_reservation_lines ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.inventory_reservation_lines TO service_role;

INSERT INTO public.inventory_reservation_lines (
  reservation_id, order_item_id, stock_sku_id, location_id, quantity
)
SELECT reservation.id, item.id, reservation.sku_id, reservation.location_id, reservation.quantity
  FROM public.inventory_reservations reservation
  JOIN public.commerce_order_items item
    ON item.order_id = reservation.order_id
   AND item.listing_id = reservation.listing_id
ON CONFLICT (reservation_id, stock_sku_id) DO NOTHING;

ALTER TABLE public.fulfillment_items
  DROP CONSTRAINT IF EXISTS fulfillment_items_expected_qty_check,
  DROP CONSTRAINT IF EXISTS fulfillment_items_picked_qty_check,
  DROP CONSTRAINT IF EXISTS fulfillment_items_packed_qty_check,
  DROP CONSTRAINT IF EXISTS fulfillment_items_fulfillment_id_order_item_id_key;
ALTER TABLE public.fulfillment_items
  ADD CONSTRAINT fulfillment_items_expected_qty_check CHECK (expected_qty > 0),
  ADD CONSTRAINT fulfillment_items_picked_qty_check CHECK (picked_qty >= 0 AND picked_qty <= expected_qty),
  ADD CONSTRAINT fulfillment_items_packed_qty_check CHECK (packed_qty >= 0 AND packed_qty <= expected_qty),
  ADD CONSTRAINT fulfillment_items_fulfillment_order_sku_key
    UNIQUE (fulfillment_id, order_item_id, sku_id);

CREATE TABLE public.commerce_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (
    provider IN ('cash', 'wechat', 'alipay', 'bank_card', 'store_credit', 'manual')
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled', 'partially_refunded', 'refunded')
  ),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'CNY',
  provider_transaction_id text,
  idempotency_key text NOT NULL,
  payment_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  failure_code text,
  failure_message text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, idempotency_key)
);
CREATE UNIQUE INDEX uniq_commerce_payment_provider_transaction
  ON public.commerce_payments(provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX idx_commerce_payments_order ON public.commerce_payments(order_id, created_at);

CREATE TABLE public.commerce_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid REFERENCES public.commerce_payments(id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_event_id text,
  event_type text NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_status text NOT NULL DEFAULT 'received' CHECK (
    processing_status IN ('received', 'processed', 'ignored', 'failed')
  ),
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE public.commerce_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  payment_id uuid NOT NULL REFERENCES public.commerce_payments(id),
  after_sale_id uuid REFERENCES public.commerce_after_sales(id),
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')
  ),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text,
  idempotency_key text NOT NULL UNIQUE,
  provider_refund_id text,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pos_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  code text NOT NULL,
  name text NOT NULL,
  device_id uuid REFERENCES public.inv_handheld_devices(id),
  receipt_prefix text NOT NULL DEFAULT 'POS',
  is_active boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, code)
);

CREATE TABLE public.pos_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id uuid NOT NULL REFERENCES public.pos_registers(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  operator_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
  opening_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  expected_cash numeric(12,2),
  counted_cash numeric(12,2),
  cash_difference numeric(12,2),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_open_pos_shift_per_register
  ON public.pos_shifts(register_id)
  WHERE status IN ('open', 'closing');
CREATE INDEX idx_pos_shifts_location_opened
  ON public.pos_shifts(location_id, opened_at DESC);

ALTER TABLE public.commerce_orders
  ADD COLUMN IF NOT EXISTS pos_shift_id uuid REFERENCES public.pos_shifts(id);

CREATE TABLE public.pos_cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id),
  order_id uuid REFERENCES public.commerce_orders(id),
  type text NOT NULL CHECK (
    type IN ('opening', 'sale', 'refund', 'cash_in', 'cash_out', 'closing_adjustment')
  ),
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  reason text,
  operator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_cash_movements_shift
  ON public.pos_cash_movements(shift_id, created_at);

CREATE TABLE public.pos_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id),
  receipt_no text NOT NULL UNIQUE,
  print_count integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  last_printed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.commerce_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_receipts ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.commerce_payments TO service_role;
GRANT ALL ON public.commerce_payment_events TO service_role;
GRANT ALL ON public.commerce_refunds TO service_role;
GRANT ALL ON public.pos_registers TO service_role;
GRANT ALL ON public.pos_shifts TO service_role;
GRANT ALL ON public.pos_cash_movements TO service_role;
GRANT ALL ON public.pos_receipts TO service_role;

ALTER TABLE public.inv_stock_movements
  DROP CONSTRAINT IF EXISTS inv_stock_movements_ref_type_check;
ALTER TABLE public.inv_stock_movements
  ADD CONSTRAINT inv_stock_movements_ref_type_check CHECK (
    ref_type IN (
      'rfid_inbound','transfer_out','transfer_in','transfer_ship','transfer_receive',
      'stocktake_adjust','youzan_sale','unclaim','manual_adjust',
      'shop_adjust','shop_new_sku','return_inspection',
      'commerce_sale','commerce_return','pos_sale','pos_return','handheld_restock'
    )
    OR ref_type LIKE 'sale:%'
  );

CREATE OR REPLACE FUNCTION public.commerce_create_order_v2(
  p_user_id uuid,
  p_idempotency_key text,
  p_items jsonb,
  p_recipient_name text,
  p_recipient_phone text,
  p_shipping_address jsonb,
  p_courier_provider text,
  p_courier_service_code text,
  p_courier_service_name text DEFAULT NULL,
  p_shipping_fee numeric DEFAULT 0,
  p_quote_snapshot jsonb DEFAULT NULL,
  p_customer_note text DEFAULT NULL
) RETURNS public.commerce_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF p_courier_provider NOT IN ('sf','cainiao','platform') THEN
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
$$;

CREATE OR REPLACE FUNCTION public.commerce_listing_availability(
  p_listing_ids uuid[]
) RETURNS TABLE (
  listing_id uuid,
  product_type text,
  available_qty integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing record;
  v_component record;
  v_stock integer;
  v_reserved integer;
  v_component_available integer;
  v_available integer;
BEGIN
  FOR v_listing IN
    SELECT listing.id, listing.sku_id, listing.location_id, listing.product_type, sku.bundle_items
      FROM public.commerce_listings listing
      JOIN public.inv_skus sku ON sku.id = listing.sku_id
     WHERE listing.id = ANY(p_listing_ids)
  LOOP
    IF v_listing.product_type = 'bundle' THEN
      v_available := NULL;
      FOR v_component IN
        SELECT component.sku_id, component.qty
          FROM jsonb_to_recordset(v_listing.bundle_items)
            AS component(sku_id uuid, qty integer)
      LOOP
        SELECT qty INTO v_stock
          FROM public.inv_stocks
         WHERE sku_id = v_component.sku_id
           AND location_id = v_listing.location_id;
        SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
          FROM public.inventory_reservation_lines line
          JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
         WHERE line.stock_sku_id = v_component.sku_id
           AND line.location_id = v_listing.location_id
           AND reservation.status = 'active'
           AND reservation.expires_at > now();
        v_component_available :=
          greatest(0, coalesce(v_stock, 0) - v_reserved) / greatest(v_component.qty, 1);
        v_available := CASE
          WHEN v_available IS NULL THEN v_component_available
          ELSE least(v_available, v_component_available)
        END;
      END LOOP;
      v_available := coalesce(v_available, 0);
    ELSE
      SELECT qty INTO v_stock
        FROM public.inv_stocks
       WHERE sku_id = v_listing.sku_id
         AND location_id = v_listing.location_id;
      SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
        FROM public.inventory_reservation_lines line
        JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
       WHERE line.stock_sku_id = v_listing.sku_id
         AND line.location_id = v_listing.location_id
         AND reservation.status = 'active'
         AND reservation.expires_at > now();
      v_available := greatest(0, coalesce(v_stock, 0) - v_reserved);
      IF v_listing.product_type = 'custom' THEN v_available := least(v_available, 1); END IF;
    END IF;
    listing_id := v_listing.id;
    product_type := v_listing.product_type;
    available_qty := v_available;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.sales_sku_available_qty(
  p_sku_id uuid,
  p_location_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sku public.inv_skus;
  v_component record;
  v_stock integer;
  v_reserved integer;
  v_component_available integer;
  v_available integer;
BEGIN
  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id;
  IF NOT FOUND OR v_sku.status <> 'active' OR NOT v_sku.is_display THEN RETURN 0; END IF;

  IF v_sku.kind = 'bundle' THEN
    IF jsonb_typeof(v_sku.bundle_items) <> 'array' OR jsonb_array_length(v_sku.bundle_items) = 0 THEN
      RETURN 0;
    END IF;
    v_available := NULL;
    FOR v_component IN
      SELECT component.sku_id, component.qty
        FROM jsonb_to_recordset(v_sku.bundle_items)
          AS component(sku_id uuid, qty integer)
    LOOP
      SELECT qty INTO v_stock
        FROM public.inv_stocks
       WHERE sku_id = v_component.sku_id
         AND location_id = p_location_id;
      SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
        FROM public.inventory_reservation_lines line
        JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
       WHERE line.stock_sku_id = v_component.sku_id
         AND line.location_id = p_location_id
         AND reservation.status = 'active'
         AND reservation.expires_at > now();
      v_component_available :=
        greatest(0, coalesce(v_stock, 0) - v_reserved) / greatest(v_component.qty, 1);
      v_available := CASE
        WHEN v_available IS NULL THEN v_component_available
        ELSE least(v_available, v_component_available)
      END;
    END LOOP;
    RETURN coalesce(v_available, 0);
  END IF;

  SELECT qty INTO v_stock
    FROM public.inv_stocks
   WHERE sku_id = p_sku_id
     AND location_id = p_location_id;
  SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
    FROM public.inventory_reservation_lines line
    JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
   WHERE line.stock_sku_id = p_sku_id
     AND line.location_id = p_location_id
     AND reservation.status = 'active'
     AND reservation.expires_at > now();
  v_available := greatest(0, coalesce(v_stock, 0) - v_reserved);
  IF v_sku.is_custom_price THEN v_available := least(v_available, 1); END IF;
  RETURN v_available;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_create_order(
  p_user_id uuid,
  p_idempotency_key text,
  p_listing_ids uuid[],
  p_recipient_name text,
  p_recipient_phone text,
  p_shipping_address jsonb,
  p_courier_provider text,
  p_courier_service_code text,
  p_courier_service_name text DEFAULT NULL,
  p_shipping_fee numeric DEFAULT 0,
  p_quote_snapshot jsonb DEFAULT NULL,
  p_customer_note text DEFAULT NULL
) RETURNS public.commerce_orders
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.commerce_create_order_v2(
    p_user_id,
    p_idempotency_key,
    (
      SELECT coalesce(
        jsonb_agg(jsonb_build_object('listing_id', listing_id, 'quantity', 1)),
        '[]'::jsonb
      )
      FROM unnest(p_listing_ids) AS value(listing_id)
    ),
    p_recipient_name,
    p_recipient_phone,
    p_shipping_address,
    p_courier_provider,
    p_courier_service_code,
    p_courier_service_name,
    p_shipping_fee,
    p_quote_snapshot,
    p_customer_note
  );
$$;

CREATE OR REPLACE FUNCTION public.commerce_mark_order_paid(
  p_order_id uuid,
  p_provider_transaction_id text,
  p_paid_at timestamptz DEFAULT now()
) RETURNS public.commerce_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.commerce_orders;
  v_line record;
  v_listing record;
  v_fulfillment_id uuid;
  v_item_count integer;
  v_active_reservation_count integer;
  v_stock integer;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_order.payment_status = 'paid' THEN
    IF v_order.provider_transaction_id = p_provider_transaction_id THEN RETURN v_order; END IF;
    RAISE EXCEPTION 'order was paid with another provider transaction';
  END IF;
  IF v_order.order_status <> 'pending_payment' THEN RAISE EXCEPTION 'order is not payable'; END IF;
  IF v_order.reservation_expires_at <= now() THEN RAISE EXCEPTION 'order reservation expired'; END IF;

  SELECT count(*) INTO v_item_count
    FROM public.commerce_order_items WHERE order_id = p_order_id;
  SELECT count(*) INTO v_active_reservation_count
    FROM public.inventory_reservations
   WHERE order_id = p_order_id
     AND status = 'active'
     AND expires_at > now();
  IF v_item_count = 0 OR v_active_reservation_count <> v_item_count THEN
    RAISE EXCEPTION 'order inventory reservation is incomplete';
  END IF;

  FOR v_line IN
    SELECT line.*, item.listing_id, item.epc, item.id AS item_id
      FROM public.inventory_reservation_lines line
      JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
      JOIN public.commerce_order_items item ON item.id = line.order_item_id
     WHERE reservation.order_id = p_order_id
       AND reservation.status = 'active'
     ORDER BY line.stock_sku_id
  LOOP
    SELECT qty INTO v_stock
      FROM public.inv_stocks
     WHERE sku_id = v_line.stock_sku_id
       AND location_id = v_line.location_id
     FOR UPDATE;
    IF coalesce(v_stock, 0) < v_line.quantity THEN
      RAISE EXCEPTION 'paid order inventory is no longer available for SKU %', v_line.stock_sku_id;
    END IF;
    PERFORM public.inv_apply_movement(
      v_line.stock_sku_id,
      v_line.location_id,
      -v_line.quantity,
      'commerce_sale',
      p_order_id,
      CASE WHEN v_line.stock_sku_id = (
        SELECT sku_id FROM public.commerce_order_items WHERE id = v_line.item_id
      ) THEN v_line.epc ELSE NULL END,
      p_provider_transaction_id
    );

    INSERT INTO public.fulfillments(order_id, location_id)
      VALUES (p_order_id, v_line.location_id)
      ON CONFLICT (order_id, location_id) DO UPDATE SET updated_at = now()
      RETURNING id INTO v_fulfillment_id;
    INSERT INTO public.fulfillment_items(
      fulfillment_id, order_item_id, sku_id, epc, expected_qty
    ) VALUES (
      v_fulfillment_id, v_line.item_id, v_line.stock_sku_id,
      CASE WHEN v_line.stock_sku_id = (
        SELECT sku_id FROM public.commerce_order_items WHERE id = v_line.item_id
      ) THEN v_line.epc ELSE NULL END,
      v_line.quantity
    ) ON CONFLICT (fulfillment_id, order_item_id, sku_id) DO NOTHING;
  END LOOP;

  UPDATE public.inventory_reservations
     SET status = 'consumed', consumed_at = p_paid_at
   WHERE order_id = p_order_id
     AND status = 'active';

  FOR v_listing IN
    SELECT listing.id, listing.product_type, item.epc
      FROM public.commerce_order_items item
      JOIN public.commerce_listings listing ON listing.id = item.listing_id
     WHERE item.order_id = p_order_id
  LOOP
    IF v_listing.product_type = 'custom' THEN
      UPDATE public.commerce_listings
         SET status = 'sold', sold_at = p_paid_at, updated_at = now()
       WHERE id = v_listing.id;
      IF v_listing.epc IS NOT NULL THEN
        UPDATE public.inv_epcs
           SET status = 'sold', current_location_id = NULL, last_seen_at = now()
         WHERE epc = v_listing.epc;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.commerce_orders
     SET payment_status = 'paid',
         order_status = 'processing',
         provider_transaction_id = p_provider_transaction_id,
         paid_at = p_paid_at,
         updated_at = now()
   WHERE id = p_order_id
  RETURNING * INTO v_order;
  RETURN v_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_complete_sale(
  p_shift_id uuid,
  p_operator_id uuid,
  p_client_op_id text,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shift public.pos_shifts;
  v_order public.commerce_orders;
  v_sku public.inv_skus;
  v_item record;
  v_component record;
  v_tender record;
  v_stock integer;
  v_available integer;
  v_required integer;
  v_unit_price numeric;
  v_subtotal numeric := 0;
  v_tender_total numeric := 0;
  v_order_item_id uuid;
  v_payment_id uuid;
  v_receipt_no text;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' THEN
    RAISE EXCEPTION 'client operation id is required';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale requires at least one item';
  END IF;
  IF jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) = 0 THEN
    RAISE EXCEPTION 'sale requires at least one tender';
  END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE source_channel = 'pos'
     AND idempotency_key = p_client_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'order_no', v_order.order_no,
      'replayed', true,
      'total_amount', v_order.total_amount
    );
  END IF;

  SELECT * INTO v_shift
    FROM public.pos_shifts
   WHERE id = p_shift_id
   FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'open' THEN RAISE EXCEPTION 'POS shift is not open'; END IF;
  IF v_shift.operator_id <> p_operator_id THEN RAISE EXCEPTION 'POS shift belongs to another operator'; END IF;

  FOR v_item IN
    SELECT item.sku_id, item.quantity
      FROM jsonb_to_recordset(p_items) AS item(sku_id uuid, quantity integer)
     ORDER BY item.sku_id
  LOOP
    IF v_item.sku_id IS NULL OR v_item.quantity IS NULL OR v_item.quantity < 1 OR v_item.quantity > 999 THEN
      RAISE EXCEPTION 'sale item quantity is invalid';
    END IF;
    SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_item.sku_id FOR UPDATE;
    IF NOT FOUND OR v_sku.status <> 'active' OR NOT v_sku.is_display THEN
      RAISE EXCEPTION 'SKU % is not sellable', v_item.sku_id;
    END IF;
    IF v_sku.kind = 'single' AND v_sku.is_custom_price AND v_item.quantity <> 1 THEN
      RAISE EXCEPTION 'custom SKU quantity must be one';
    END IF;
    v_available := public.sales_sku_available_qty(v_sku.id, v_shift.location_id);
    IF v_available < v_item.quantity THEN
      RAISE EXCEPTION 'SKU % has insufficient available stock', v_sku.id;
    END IF;
    v_unit_price := v_sku.price_tier;
    v_subtotal := v_subtotal + v_unit_price * v_item.quantity;
  END LOOP;

  FOR v_tender IN
    SELECT tender.provider, tender.amount, tender.provider_transaction_id
      FROM jsonb_to_recordset(p_tenders)
        AS tender(provider text, amount numeric, provider_transaction_id text)
  LOOP
    IF v_tender.provider NOT IN ('cash','wechat','alipay','bank_card','store_credit','manual') THEN
      RAISE EXCEPTION 'unsupported tender provider';
    END IF;
    IF v_tender.amount IS NULL OR v_tender.amount <= 0 THEN
      RAISE EXCEPTION 'tender amount is invalid';
    END IF;
    v_tender_total := v_tender_total + v_tender.amount;
  END LOOP;
  IF round(v_tender_total, 2) <> round(v_subtotal, 2) THEN
    RAISE EXCEPTION 'tender total does not match sale total';
  END IF;

  INSERT INTO public.commerce_orders (
    user_id, source_channel, fulfillment_method, sale_location_id, operator_id,
    customer_id, pos_shift_id, payment_status, order_status, subtotal,
    total_amount, recipient_name, recipient_phone, shipping_address,
    courier_provider, courier_service_code, idempotency_key,
    reservation_expires_at, paid_at, completed_at, customer_note
  ) VALUES (
    NULL, 'pos', 'carryout', v_shift.location_id, p_operator_id,
    p_customer_id, p_shift_id, 'paid', 'completed', v_subtotal,
    v_subtotal, NULL, NULL, NULL, NULL, NULL, p_client_op_id,
    now(), now(), now(), p_note
  ) RETURNING * INTO v_order;

  FOR v_item IN
    SELECT item.sku_id, item.quantity
      FROM jsonb_to_recordset(p_items) AS item(sku_id uuid, quantity integer)
     ORDER BY item.sku_id
  LOOP
    SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_item.sku_id FOR UPDATE;
    v_unit_price := v_sku.price_tier;
    INSERT INTO public.commerce_order_items (
      order_id, listing_id, sku_id, location_id, epc, title_snapshot,
      image_snapshot, condition_snapshot, unit_price, quantity, line_total
    )
    VALUES (
      v_order.id,
      NULL,
      v_sku.id,
      v_shift.location_id,
      CASE WHEN v_sku.kind = 'single' AND v_sku.is_custom_price THEN v_sku.epc ELSE NULL END,
      v_sku.name,
      v_sku.image_url,
      v_sku.grade,
      v_unit_price,
      v_item.quantity,
      v_unit_price * v_item.quantity
    )
    RETURNING id INTO v_order_item_id;

    IF v_sku.kind = 'bundle' THEN
      IF jsonb_typeof(v_sku.bundle_items) <> 'array' OR jsonb_array_length(v_sku.bundle_items) = 0 THEN
        RAISE EXCEPTION 'bundle SKU % has no components', v_sku.id;
      END IF;
      FOR v_component IN
        SELECT component.sku_id, component.qty
          FROM jsonb_to_recordset(v_sku.bundle_items) AS component(sku_id uuid, qty integer)
         ORDER BY component.sku_id
      LOOP
        v_required := v_item.quantity * v_component.qty;
        SELECT qty INTO v_stock
          FROM public.inv_stocks
         WHERE sku_id = v_component.sku_id
           AND location_id = v_shift.location_id
         FOR UPDATE;
        IF coalesce(v_stock, 0) < v_required THEN
          RAISE EXCEPTION 'bundle component % is out of stock', v_component.sku_id;
        END IF;
        PERFORM public.inv_apply_movement(
          v_component.sku_id, v_shift.location_id, -v_required,
          'pos_sale', v_order.id, NULL, p_client_op_id
        );
      END LOOP;
    ELSE
      SELECT qty INTO v_stock
        FROM public.inv_stocks
       WHERE sku_id = v_sku.id
         AND location_id = v_shift.location_id
       FOR UPDATE;
      IF coalesce(v_stock, 0) < v_item.quantity THEN
        RAISE EXCEPTION 'SKU % is out of stock', v_sku.id;
      END IF;
      PERFORM public.inv_apply_movement(
        v_sku.id, v_shift.location_id, -v_item.quantity,
        'pos_sale', v_order.id,
        CASE WHEN v_sku.is_custom_price THEN v_sku.epc ELSE NULL END,
        p_client_op_id
      );
      IF v_sku.is_custom_price THEN
        UPDATE public.inv_skus
           SET sales_state = 'sold', updated_at = now()
         WHERE id = v_sku.id;
        UPDATE public.inv_epcs
           SET status = 'sold', current_location_id = NULL, last_seen_at = now()
         WHERE epc = v_sku.epc;
        UPDATE public.commerce_listings
           SET status = 'sold', sold_at = now(), updated_at = now()
         WHERE sku_id = v_sku.id
           AND status IN ('published', 'reserved');
      END IF;
    END IF;
  END LOOP;

  FOR v_tender IN
    SELECT tender.provider, tender.amount, tender.provider_transaction_id
      FROM jsonb_to_recordset(p_tenders)
        AS tender(provider text, amount numeric, provider_transaction_id text)
  LOOP
    INSERT INTO public.commerce_payments (
      order_id, provider, status, amount, provider_transaction_id,
      idempotency_key, paid_at
    ) VALUES (
      v_order.id, v_tender.provider, 'succeeded', v_tender.amount,
      v_tender.provider_transaction_id,
      p_client_op_id || ':' || v_tender.provider,
      now()
    ) RETURNING id INTO v_payment_id;
    INSERT INTO public.commerce_payment_events (
      payment_id, provider, provider_event_id, event_type,
      signature_verified, payload, processing_status, processed_at
    ) VALUES (
      v_payment_id, v_tender.provider,
      coalesce(v_tender.provider_transaction_id, p_client_op_id || ':' || v_tender.provider),
      'pos_payment_succeeded', true,
      jsonb_build_object('amount', v_tender.amount, 'shift_id', p_shift_id),
      'processed', now()
    );
    IF v_tender.provider = 'cash' THEN
      INSERT INTO public.pos_cash_movements (
        shift_id, order_id, type, amount, reason, operator_id
      ) VALUES (
        p_shift_id, v_order.id, 'sale', v_tender.amount, 'POS sale', p_operator_id
      );
    END IF;
  END LOOP;

  v_receipt_no := (
    SELECT receipt_prefix FROM public.pos_registers WHERE id = v_shift.register_id
  ) || '-' || to_char(now(), 'YYYYMMDD') || '-' || right(v_order.order_no, 6);
  INSERT INTO public.pos_receipts (
    order_id, shift_id, receipt_no, payload
  ) VALUES (
    v_order.id, p_shift_id, v_receipt_no,
    jsonb_build_object(
      'order_no', v_order.order_no,
      'receipt_no', v_receipt_no,
      'total_amount', v_order.total_amount,
      'paid_at', v_order.paid_at
    )
  );

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'order_no', v_order.order_no,
    'receipt_no', v_receipt_no,
    'replayed', false,
    'total_amount', v_order.total_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_order_v2(
  uuid,text,jsonb,text,text,jsonb,text,text,text,numeric,jsonb,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_create_order(
  uuid,text,uuid[],text,text,jsonb,text,text,text,numeric,jsonb,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_listing_availability(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sales_sku_available_qty(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_mark_order_paid(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_complete_sale(
  uuid,uuid,text,jsonb,jsonb,uuid,text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.commerce_create_order_v2(
  uuid,text,jsonb,text,text,jsonb,text,text,text,numeric,jsonb,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_order(
  uuid,text,uuid[],text,text,jsonb,text,text,text,numeric,jsonb,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_listing_availability(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_sku_available_qty(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_mark_order_paid(uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(
  uuid,uuid,text,jsonb,jsonb,uuid,text
) TO service_role;
