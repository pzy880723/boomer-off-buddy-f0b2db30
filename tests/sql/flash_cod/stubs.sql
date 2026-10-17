-- 闪送到付隔离测试夹具：表结构与真实库关键列/约束一致（0087 的 ALTER 依赖同名约束）。
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.inv_locations (id uuid PRIMARY KEY, kind text DEFAULT 'shop', is_active boolean DEFAULT true);
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.user_location_perms (user_id uuid, location_id uuid);
CREATE TABLE public.commerce_customers (id uuid PRIMARY KEY, status text DEFAULT 'active');
CREATE TABLE public.inv_skus (id uuid PRIMARY KEY, sale_ownership text DEFAULT 'owned', settlement_party_ref text);
CREATE TABLE public.commerce_listings (id uuid PRIMARY KEY, location_id uuid, sku_id uuid);
CREATE TABLE public.pos_customer_coupons (id uuid PRIMARY KEY, customer_id uuid, status text DEFAULT 'active', reserved_order_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE public.commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid, idempotency_key text, source_channel text DEFAULT 'storefront',
  payment_status text DEFAULT 'unpaid', order_status text DEFAULT 'pending_payment',
  fulfillment_method text DEFAULT 'shipping',
  courier_provider text, courier_service_code text, courier_service_name text,
  recipient_name text, recipient_phone text, shipping_address jsonb,
  shipping_fee numeric DEFAULT 0, subtotal numeric DEFAULT 0, discount_total numeric DEFAULT 0,
  discount_snapshot jsonb, total_amount numeric DEFAULT 0, currency text DEFAULT 'CNY',
  payment_route jsonb, customer_note text, courier_quote_snapshot jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT commerce_orders_fulfillment_method_check CHECK (fulfillment_method = ANY (ARRAY['shipping','pickup','carryout'])),
  CONSTRAINT commerce_orders_courier_provider_check CHECK (courier_provider = ANY (ARRAY['sf','cainiao','platform']))
);
CREATE TABLE public.commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, listing_id uuid, location_id uuid,
  quantity int, line_total numeric DEFAULT 0, discount_total numeric DEFAULT 0,
  discount_snapshot jsonb, ownership_snapshot text, settlement_snapshot jsonb);
CREATE TABLE public.inventory_reservation_lines (order_item_id uuid, stock_sku_id uuid);
CREATE TABLE public.fulfillments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, location_id uuid, status text DEFAULT 'allocated', handed_over_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE TABLE public.fulfillment_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, order_item_id uuid, expected_qty int CHECK (expected_qty>0), picked_qty int DEFAULT 0, picked_at timestamptz, CHECK (picked_qty>=0 AND picked_qty<=expected_qty));
CREATE TABLE public.fulfillment_shortages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, fulfillment_item_id uuid, quantity int, status text, refund_state text, order_id uuid, refund_intent_id uuid, refund_total_fen int);
CREATE TABLE public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid UNIQUE, provider text,
  service_code text, status text, tracking_no text, carrier_label text,
  idempotency_key text UNIQUE, request_fingerprint text, booked_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());

-- 基础报价夹具：按 items 内容 md5 取回报价 JSON
CREATE TABLE public.quote_fixtures (items_key text PRIMARY KEY, quote jsonb);
CREATE OR REPLACE FUNCTION public.commerce_quote_checkout(p_customer_id uuid, p_items jsonb, p_coupon_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT quote FROM public.quote_fixtures WHERE items_key = md5(p_items::text)
$$;

-- 下单底层夹具：写订单+子单+明细，返回订单行（模拟真实 commerce_create_order_v2 的落库形状）
CREATE OR REPLACE FUNCTION public.commerce_create_order_v2(
  p_user_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text,
  p_shipping_address jsonb, p_courier_provider text, p_courier_service_code text, p_courier_service_name text,
  p_shipping_fee numeric, p_quote_snapshot jsonb, p_customer_note text)
RETURNS public.commerce_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.commerce_orders; v_item jsonb; v_f uuid; v_oi uuid; v_listing record;
BEGIN
  INSERT INTO public.commerce_orders (customer_id, idempotency_key, source_channel, payment_status, order_status,
      fulfillment_method, courier_provider, courier_service_code, courier_service_name,
      recipient_name, recipient_phone, shipping_address, shipping_fee,
      subtotal, total_amount, courier_quote_snapshot, customer_note)
    VALUES (p_user_id, p_idempotency_key, 'storefront', 'unpaid', 'pending_payment', 'shipping',
      p_courier_provider, p_courier_service_code, p_courier_service_name,
      p_recipient_name, p_recipient_phone, p_shipping_address, p_shipping_fee,
      coalesce((p_quote_snapshot->>'subtotal_fen')::numeric,0)/100,
      coalesce((p_quote_snapshot->>'total_fen')::numeric,0)/100,
      p_quote_snapshot, p_customer_note)
    RETURNING * INTO v_order;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_listing FROM public.commerce_listings WHERE id = (v_item->>'listing_id')::uuid;
    INSERT INTO public.commerce_order_items (order_id, listing_id, location_id, quantity, line_total)
      VALUES (v_order.id, v_listing.id, v_listing.location_id, (v_item->>'quantity')::int, 0) RETURNING id INTO v_oi;
    SELECT id INTO v_f FROM public.fulfillments WHERE order_id = v_order.id AND location_id = v_listing.location_id;
    IF v_f IS NULL THEN
      INSERT INTO public.fulfillments (order_id, location_id, status) VALUES (v_order.id, v_listing.location_id, 'allocated') RETURNING id INTO v_f;
    END IF;
    INSERT INTO public.fulfillment_items (fulfillment_id, order_item_id, expected_qty) VALUES (v_f, v_oi, (v_item->>'quantity')::int);
  END LOOP;
  RETURN v_order;
END $$;

-- 结算阻断夹具：与真实语义一致的简化版
CREATE OR REPLACE FUNCTION public.commerce_order_settlement_block(p_order_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN o.order_status IN ('cancelled','closed') THEN 'cancelled'
    WHEN o.payment_status IN ('refund_pending','partially_refunded','refunded') THEN 'refund_blocked'
    WHEN o.payment_status <> 'paid' THEN 'unpaid'
    ELSE NULL END
  FROM public.commerce_orders o WHERE o.id = p_order_id
$$;
CREATE OR REPLACE FUNCTION public.commerce_item_cleared_shortage_qty(p_fulfillment_item_id uuid)
RETURNS int LANGUAGE sql STABLE SET search_path = public AS $$ SELECT 0 $$;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
