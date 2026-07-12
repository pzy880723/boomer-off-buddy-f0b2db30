CREATE SEQUENCE IF NOT EXISTS public.commerce_order_number_seq START 100001;

CREATE OR REPLACE FUNCTION public.gen_commerce_order_no()
RETURNS text LANGUAGE sql AS $$
  SELECT 'BO' || to_char(now(), 'YYYYMMDD') || lpad(nextval('public.commerce_order_number_seq')::text, 6, '0');
$$;

CREATE TABLE public.commerce_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  epc text REFERENCES public.inv_epcs(epc),
  title text NOT NULL,
  description text,
  cover_url text,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  compare_at_price numeric(12,2),
  condition_grade text,
  category text,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft','published','reserved','sold','hidden','archived')
  ),
  published_at timestamptz,
  sold_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, location_id)
);
CREATE INDEX idx_commerce_listings_public ON public.commerce_listings(status, published_at DESC);
CREATE INDEX idx_commerce_listings_location ON public.commerce_listings(location_id, status);

CREATE TABLE public.commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no text NOT NULL UNIQUE DEFAULT public.gen_commerce_order_no(),
  user_id uuid NOT NULL,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (
    payment_status IN ('unpaid','paid','refund_pending','partially_refunded','refunded','payment_failed')
  ),
  order_status text NOT NULL DEFAULT 'pending_payment' CHECK (
    order_status IN ('pending_payment','confirmed','processing','completed','cancelled','after_sale','closed')
  ),
  currency text NOT NULL DEFAULT 'CNY',
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  shipping_fee numeric(12,2) NOT NULL DEFAULT 0,
  discount_total numeric(12,2) NOT NULL DEFAULT 0,
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  recipient_name text NOT NULL,
  recipient_phone text NOT NULL,
  shipping_address jsonb NOT NULL,
  courier_provider text NOT NULL CHECK (courier_provider IN ('sf','cainiao','platform')),
  courier_service_code text NOT NULL,
  courier_service_name text,
  courier_quote_snapshot jsonb,
  customer_note text,
  idempotency_key text NOT NULL,
  reservation_expires_at timestamptz NOT NULL,
  provider_transaction_id text UNIQUE,
  paid_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX idx_commerce_orders_user ON public.commerce_orders(user_id, created_at DESC);
CREATE INDEX idx_commerce_orders_status ON public.commerce_orders(order_status, created_at DESC);
CREATE INDEX idx_commerce_orders_reservation_expiry
  ON public.commerce_orders(reservation_expires_at)
  WHERE payment_status = 'unpaid' AND order_status = 'pending_payment';

CREATE TABLE public.commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.commerce_listings(id),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  epc text,
  title_snapshot text NOT NULL,
  image_snapshot text,
  condition_snapshot text,
  unit_price numeric(12,2) NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  line_total numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, listing_id)
);
CREATE INDEX idx_commerce_order_items_order ON public.commerce_order_items(order_id);

CREATE TABLE public.inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.commerce_listings(id),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released','expired')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, listing_id)
);
CREATE UNIQUE INDEX uniq_active_listing_reservation
  ON public.inventory_reservations(listing_id) WHERE status = 'active';
CREATE INDEX idx_inventory_reservations_expiry
  ON public.inventory_reservations(expires_at) WHERE status = 'active';

CREATE TABLE public.fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT ('FF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  status text NOT NULL DEFAULT 'allocated' CHECK (
    status IN ('unallocated','allocated','picking','picked','packing','packed','handover_ready','handed_over','exception')
  ),
  priority integer NOT NULL DEFAULT 0,
  claimed_by uuid,
  claimed_device_id uuid REFERENCES public.inv_handheld_devices(id),
  claimed_at timestamptz,
  tote_id uuid,
  picking_started_at timestamptz,
  picked_at timestamptz,
  packing_started_at timestamptz,
  packed_at timestamptz,
  handed_over_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, location_id)
);
CREATE INDEX idx_fulfillments_location_status ON public.fulfillments(location_id, status, priority DESC);

CREATE TABLE public.fulfillment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.commerce_order_items(id),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  epc text,
  expected_qty integer NOT NULL DEFAULT 1 CHECK (expected_qty = 1),
  picked_qty integer NOT NULL DEFAULT 0 CHECK (picked_qty IN (0,1)),
  packed_qty integer NOT NULL DEFAULT 0 CHECK (packed_qty IN (0,1)),
  picked_at timestamptz,
  packed_at timestamptz,
  UNIQUE (fulfillment_id, order_item_id)
);

CREATE TABLE public.warehouse_totes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','cleaning','disabled')),
  current_fulfillment_id uuid REFERENCES public.fulfillments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fulfillments
  ADD CONSTRAINT fulfillments_tote_fk FOREIGN KEY (tote_id) REFERENCES public.warehouse_totes(id);

CREATE TABLE public.fulfillment_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  fulfillment_item_id uuid REFERENCES public.fulfillment_items(id),
  phase text NOT NULL CHECK (phase IN ('pick','pack','handover')),
  code text NOT NULL,
  code_type text NOT NULL CHECK (code_type IN ('epc','barcode','sku_code','waybill')),
  result text NOT NULL CHECK (result IN ('accepted','rejected','undone')),
  rejection_reason text,
  device_id uuid REFERENCES public.inv_handheld_devices(id),
  operator_id uuid,
  client_op_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_fulfillment_scan_client_op
  ON public.fulfillment_scans(device_id, client_op_id) WHERE client_op_id IS NOT NULL;

CREATE TABLE public.fulfillment_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  fulfillment_item_id uuid REFERENCES public.fulfillment_items(id),
  kind text NOT NULL CHECK (kind IN ('missing','damaged','wrong_label','wrong_item','address_hold','other')),
  description text,
  evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled')),
  reported_by uuid,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  weight_g numeric(12,2) CHECK (weight_g > 0),
  length_cm numeric(10,2),
  width_cm numeric(10,2),
  height_cm numeric(10,2),
  packaging_material text,
  sealed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.package_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES public.packages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('before_seal','after_seal','damage','handover')),
  storage_path text NOT NULL,
  captured_by uuid,
  device_id uuid REFERENCES public.inv_handheld_devices(id),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (package_id, kind, storage_path)
);

CREATE TABLE public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  package_id uuid REFERENCES public.packages(id),
  provider text NOT NULL CHECK (provider IN ('sf','cainiao')),
  service_code text NOT NULL,
  status text NOT NULL DEFAULT 'not_created' CHECK (
    status IN ('not_created','quoting','booked','label_created','picked_up','in_transit','delivered','cancelled','failed')
  ),
  provider_order_no text,
  tracking_no text,
  idempotency_key text NOT NULL UNIQUE,
  label_payload jsonb,
  pickup_window jsonb,
  last_error text,
  booked_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  provider_event_id text,
  event_code text NOT NULL,
  event_time timestamptz NOT NULL,
  description text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, provider_event_id)
);

CREATE TABLE public.print_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  shipment_id uuid REFERENCES public.shipments(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('pick_slip','shipping_label')),
  template_version text NOT NULL,
  result text NOT NULL CHECK (result IN ('success','failed')),
  copies integer NOT NULL DEFAULT 1 CHECK (copies > 0),
  error_message text,
  device_id uuid REFERENCES public.inv_handheld_devices(id),
  operator_id uuid,
  client_op_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_print_event_client_op
  ON public.print_events(device_id, client_op_id) WHERE client_op_id IS NOT NULL;

ALTER TABLE public.commerce_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_totes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.print_events ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.commerce_listings, public.commerce_orders, public.commerce_order_items,
  public.inventory_reservations, public.fulfillments, public.fulfillment_items,
  public.warehouse_totes, public.fulfillment_scans, public.fulfillment_exceptions,
  public.packages, public.package_evidence, public.shipments, public.shipment_events,
  public.print_events TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_order(
  p_user_id uuid, p_idempotency_key text, p_listing_ids uuid[],
  p_recipient_name text, p_recipient_phone text, p_shipping_address jsonb,
  p_courier_provider text, p_courier_service_code text,
  p_courier_service_name text DEFAULT NULL, p_shipping_fee numeric DEFAULT 0,
  p_quote_snapshot jsonb DEFAULT NULL, p_customer_note text DEFAULT NULL
) RETURNS public.commerce_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.commerce_orders;
  v_listing public.commerce_listings;
  v_stock integer;
  v_subtotal numeric := 0;
  v_expires_at timestamptz := now() + interval '15 minutes';
  v_listing_id uuid;
BEGIN
  IF coalesce(array_length(p_listing_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'order requires at least one listing'; END IF;
  IF cardinality(p_listing_ids) <> (SELECT count(DISTINCT listing_id) FROM unnest(p_listing_ids) AS value(listing_id)) THEN
    RAISE EXCEPTION 'order contains duplicate listings';
  END IF;
  IF p_courier_provider NOT IN ('sf','cainiao','platform') THEN RAISE EXCEPTION 'unsupported courier provider'; END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_order; END IF;
  INSERT INTO public.commerce_orders (
    user_id, idempotency_key, recipient_name, recipient_phone, shipping_address,
    courier_provider, courier_service_code, courier_service_name,
    shipping_fee, courier_quote_snapshot, customer_note, reservation_expires_at
  ) VALUES (
    p_user_id, p_idempotency_key, p_recipient_name, p_recipient_phone, p_shipping_address,
    p_courier_provider, p_courier_service_code, p_courier_service_name,
    greatest(p_shipping_fee, 0), p_quote_snapshot, p_customer_note, v_expires_at
  ) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING * INTO v_order;
  IF NOT FOUND THEN
    SELECT * INTO v_order FROM public.commerce_orders WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    RETURN v_order;
  END IF;
  FOREACH v_listing_id IN ARRAY p_listing_ids LOOP
    SELECT * INTO v_listing FROM public.commerce_listings WHERE id = v_listing_id FOR UPDATE;
    IF NOT FOUND OR v_listing.status <> 'published' THEN RAISE EXCEPTION 'listing % is not available', v_listing_id; END IF;
    SELECT qty INTO v_stock FROM public.inv_stocks WHERE sku_id = v_listing.sku_id AND location_id = v_listing.location_id FOR UPDATE;
    IF coalesce(v_stock, 0) < 1 THEN RAISE EXCEPTION 'listing % is out of stock', v_listing_id; END IF;
    INSERT INTO public.commerce_order_items (
      order_id, listing_id, sku_id, location_id, epc, title_snapshot,
      image_snapshot, condition_snapshot, unit_price, line_total
    ) VALUES (
      v_order.id, v_listing.id, v_listing.sku_id, v_listing.location_id, v_listing.epc,
      v_listing.title, v_listing.cover_url, v_listing.condition_grade, v_listing.price, v_listing.price
    );
    INSERT INTO public.inventory_reservations (order_id, listing_id, sku_id, location_id, expires_at)
      VALUES (v_order.id, v_listing.id, v_listing.sku_id, v_listing.location_id, v_expires_at);
    UPDATE public.commerce_listings SET status = 'reserved', updated_at = now() WHERE id = v_listing.id;
    v_subtotal := v_subtotal + v_listing.price;
  END LOOP;
  UPDATE public.commerce_orders SET subtotal = v_subtotal, total_amount = v_subtotal + greatest(p_shipping_fee, 0), updated_at = now()
    WHERE id = v_order.id RETURNING * INTO v_order;
  RETURN v_order;
END; $$;

CREATE OR REPLACE FUNCTION public.commerce_mark_order_paid(
  p_order_id uuid, p_provider_transaction_id text, p_paid_at timestamptz DEFAULT now()
) RETURNS public.commerce_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.commerce_orders;
  v_item record;
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
  SELECT count(*) INTO v_item_count FROM public.commerce_order_items WHERE order_id = p_order_id;
  SELECT count(*) INTO v_active_reservation_count FROM public.inventory_reservations
    WHERE order_id = p_order_id AND status = 'active' AND expires_at > now();
  IF v_item_count = 0 OR v_active_reservation_count <> v_item_count THEN RAISE EXCEPTION 'order inventory reservation is incomplete'; END IF;
  UPDATE public.commerce_orders SET payment_status = 'paid', order_status = 'processing',
    provider_transaction_id = p_provider_transaction_id, paid_at = p_paid_at, updated_at = now() WHERE id = p_order_id;
  UPDATE public.inventory_reservations SET status = 'consumed', consumed_at = p_paid_at
    WHERE order_id = p_order_id AND status = 'active';
  FOR v_item IN SELECT * FROM public.commerce_order_items WHERE order_id = p_order_id LOOP
    SELECT qty INTO v_stock FROM public.inv_stocks WHERE sku_id = v_item.sku_id AND location_id = v_item.location_id FOR UPDATE;
    IF coalesce(v_stock, 0) < 1 THEN RAISE EXCEPTION 'paid order inventory is no longer available for listing %', v_item.listing_id; END IF;
    PERFORM public.inv_apply_movement(v_item.sku_id, v_item.location_id, -1, 'commerce_sale', p_order_id, v_item.epc, p_provider_transaction_id);
    UPDATE public.commerce_listings SET status = 'sold', sold_at = p_paid_at, updated_at = now() WHERE id = v_item.listing_id;
    IF v_item.epc IS NOT NULL THEN
      UPDATE public.inv_epcs SET status = 'sold', current_location_id = NULL, last_seen_at = now() WHERE epc = v_item.epc;
    END IF;
    INSERT INTO public.fulfillments(order_id, location_id) VALUES (p_order_id, v_item.location_id)
      ON CONFLICT (order_id, location_id) DO UPDATE SET updated_at = now() RETURNING id INTO v_fulfillment_id;
    INSERT INTO public.fulfillment_items(fulfillment_id, order_item_id, sku_id, epc)
      VALUES (v_fulfillment_id, v_item.id, v_item.sku_id, v_item.epc)
      ON CONFLICT (fulfillment_id, order_item_id) DO NOTHING;
  END LOOP;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id;
  RETURN v_order;
END; $$;

CREATE OR REPLACE FUNCTION public.commerce_release_expired_reservations()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer := 0;
BEGIN
  WITH expired AS (
    UPDATE public.inventory_reservations r SET status = 'expired', released_at = now()
      FROM public.commerce_orders o WHERE r.order_id = o.id AND r.status = 'active'
        AND r.expires_at <= now() AND o.payment_status = 'unpaid'
      RETURNING r.listing_id, r.order_id
  ), restored AS (
    UPDATE public.commerce_listings l SET status = 'published', updated_at = now()
      FROM expired e WHERE l.id = e.listing_id AND l.status = 'reserved' RETURNING l.id
  ), closed AS (
    UPDATE public.commerce_orders o SET order_status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE o.payment_status = 'unpaid' AND o.order_status = 'pending_payment' AND o.reservation_expires_at <= now()
      RETURNING o.id
  )
  SELECT count(*) INTO v_count FROM closed;
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_claim_task(
  p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid, p_operator_id uuid DEFAULT NULL
) RETURNS public.fulfillments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.fulfillments;
BEGIN
  UPDATE public.fulfillments SET
    status = CASE WHEN status = 'allocated' THEN 'picking' ELSE status END,
    claimed_by = coalesce(claimed_by, p_operator_id),
    claimed_device_id = coalesce(claimed_device_id, p_device_id),
    claimed_at = coalesce(claimed_at, now()),
    picking_started_at = coalesce(picking_started_at, now()),
    updated_at = now()
  WHERE id = p_fulfillment_id AND location_id = p_location_id
    AND status IN ('allocated','picking')
    AND (claimed_device_id IS NULL OR claimed_device_id = p_device_id)
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment is unavailable or claimed by another device'; END IF;
  RETURN v_row;
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_bind_tote(
  p_fulfillment_id uuid, p_location_id uuid, p_tote_code text
) RETURNS public.fulfillments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fulfillment public.fulfillments; v_tote public.warehouse_totes;
BEGIN
  SELECT * INTO v_fulfillment FROM public.fulfillments WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment not found at this location'; END IF;
  IF v_fulfillment.status NOT IN ('allocated','picking') THEN RAISE EXCEPTION 'fulfillment cannot bind tote'; END IF;
  SELECT * INTO v_tote FROM public.warehouse_totes WHERE code = p_tote_code AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tote not found at this location'; END IF;
  IF v_tote.status <> 'available' AND v_tote.current_fulfillment_id <> p_fulfillment_id THEN RAISE EXCEPTION 'tote is already in use'; END IF;
  UPDATE public.warehouse_totes SET status = 'in_use', current_fulfillment_id = p_fulfillment_id, updated_at = now() WHERE id = v_tote.id;
  UPDATE public.fulfillments SET tote_id = v_tote.id, updated_at = now() WHERE id = p_fulfillment_id RETURNING * INTO v_fulfillment;
  RETURN v_fulfillment;
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_pick_scan(
  p_fulfillment_id uuid, p_location_id uuid, p_code text, p_device_id uuid,
  p_operator_id uuid DEFAULT NULL, p_client_op_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fulfillment public.fulfillments; v_item public.fulfillment_items; v_total integer; v_picked integer;
BEGIN
  IF p_client_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fulfillment_scans WHERE device_id = p_device_id AND client_op_id = p_client_op_id
  ) THEN
    SELECT count(*), count(*) FILTER (WHERE picked_qty = expected_qty) INTO v_total, v_picked
      FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
    RETURN jsonb_build_object('accepted', true, 'replayed', true, 'picked', v_picked, 'total', v_total);
  END IF;
  SELECT * INTO v_fulfillment FROM public.fulfillments WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment not found at this location'; END IF;
  IF v_fulfillment.status NOT IN ('allocated','picking') THEN RAISE EXCEPTION 'fulfillment is not pickable'; END IF;
  SELECT fi.* INTO v_item FROM public.fulfillment_items fi JOIN public.inv_skus sku ON sku.id = fi.sku_id
    WHERE fi.fulfillment_id = p_fulfillment_id
      AND (fi.epc = p_code OR sku.epc = p_code OR sku.barcode = p_code OR sku.sku_code = p_code)
    LIMIT 1 FOR UPDATE OF fi;
  IF NOT FOUND THEN
    INSERT INTO public.fulfillment_scans(
      fulfillment_id, phase, code, code_type, result, rejection_reason, device_id, operator_id, client_op_id
    ) VALUES (
      p_fulfillment_id, 'pick', p_code, 'barcode', 'rejected', 'wrong_item', p_device_id, p_operator_id, p_client_op_id
    );
    SELECT count(*), count(*) FILTER (WHERE picked_qty = expected_qty) INTO v_total, v_picked
      FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
    RETURN jsonb_build_object('accepted', false, 'reason', 'wrong_item', 'picked', v_picked, 'total', v_total);
  END IF;
  UPDATE public.fulfillment_items SET picked_qty = 1, picked_at = coalesce(picked_at, now()) WHERE id = v_item.id;
  INSERT INTO public.fulfillment_scans(
    fulfillment_id, fulfillment_item_id, phase, code, code_type, result, device_id, operator_id, client_op_id
  ) VALUES (
    p_fulfillment_id, v_item.id, 'pick', p_code,
    CASE WHEN v_item.epc = p_code THEN 'epc' ELSE 'barcode' END,
    'accepted', p_device_id, p_operator_id, p_client_op_id
  );
  UPDATE public.fulfillments SET status = 'picking', picking_started_at = coalesce(picking_started_at, now()), updated_at = now()
    WHERE id = p_fulfillment_id;
  SELECT count(*), count(*) FILTER (WHERE picked_qty = expected_qty) INTO v_total, v_picked
    FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
  RETURN jsonb_build_object('accepted', true, 'replayed', false, 'item_id', v_item.id, 'picked', v_picked, 'total', v_total);
END; $$;

CREATE OR REPLACE FUNCTION public.fulfillment_complete_pick(
  p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid
) RETURNS public.fulfillments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.fulfillments; v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing FROM public.fulfillment_items
    WHERE fulfillment_id = p_fulfillment_id AND picked_qty <> expected_qty;
  IF v_missing > 0 THEN RAISE EXCEPTION 'fulfillment still has unpicked items'; END IF;
  UPDATE public.fulfillments SET status = 'picked', picked_at = now(), updated_at = now()
    WHERE id = p_fulfillment_id AND location_id = p_location_id AND status = 'picking'
      AND (claimed_device_id IS NULL OR claimed_device_id = p_device_id)
    RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.commerce_create_order(uuid,text,uuid[],text,text,jsonb,text,text,text,numeric,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_mark_order_paid(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_release_expired_reservations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_claim_task(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_bind_tote(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_pick_scan(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fulfillment_complete_pick(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commerce_create_order(uuid,text,uuid[],text,text,jsonb,text,text,text,numeric,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_mark_order_paid(uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_release_expired_reservations() TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_claim_task(uuid,uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_bind_tote(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_pick_scan(uuid,uuid,text,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_complete_pick(uuid,uuid,uuid) TO service_role;

-- Extend movement audit while preserving all existing ref_type values.
ALTER TABLE public.inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_ref_type_check;
ALTER TABLE public.inv_stock_movements ADD CONSTRAINT inv_stock_movements_ref_type_check CHECK (
  ref_type IN (
    'rfid_inbound','transfer_out','transfer_in','transfer_ship','transfer_receive',
    'stocktake_adjust','youzan_sale','unclaim','manual_adjust',
    'shop_adjust','shop_new_sku','return_inspection',
    'commerce_sale','commerce_return'
  )
  OR ref_type LIKE 'sale:%'
);