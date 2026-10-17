-- 闪送到付隔离测试夹具：表结构与真实库关键列/约束一致（0087 的 ALTER 依赖同名约束）。
-- 底层函数 commerce_create_order_v2 / commerce_mark_ordinary_order_paid 使用从真实库
-- pg_get_functiondef 导出的原文（real_*.sql），不用简化 stub；仅叶子库存流水 inv_apply_movement
-- 用忠实最小实现（真实版会调用手持同步链，与被测函数无关）。
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.inv_locations (id uuid PRIMARY KEY, kind text DEFAULT 'shop', is_active boolean DEFAULT true);
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.user_location_perms (user_id uuid, location_id uuid);
CREATE TABLE public.commerce_customers (id uuid PRIMARY KEY, status text DEFAULT 'active');
CREATE TABLE public.inv_skus (id uuid PRIMARY KEY, sale_ownership text DEFAULT 'owned', settlement_party_ref text,
  status text DEFAULT 'active', is_display boolean DEFAULT true, bundle_items jsonb,
  inventory_policy text DEFAULT 'tracked', stock_qty int DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.inv_stocks (sku_id uuid, location_id uuid, qty int DEFAULT 0, updated_at timestamptz DEFAULT now(),
  UNIQUE (sku_id, location_id));
CREATE TABLE public.inv_stock_movements (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku_id uuid, location_id uuid, delta int, balance_after int, ref_type text, ref_id uuid, epc text, note text, created_by uuid);
CREATE TABLE public.inv_epcs (epc text PRIMARY KEY, status text, current_location_id uuid, last_seen_at timestamptz);
CREATE TABLE public.commerce_listings (id uuid PRIMARY KEY, location_id uuid, sku_id uuid,
  status text DEFAULT 'published', product_type text DEFAULT 'custom', epc text, title text,
  cover_url text, condition_grade text, price numeric DEFAULT 0, sold_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE TABLE public.pos_customer_coupons (id uuid PRIMARY KEY, customer_id uuid, status text DEFAULT 'active', reserved_order_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE public.commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, customer_id uuid, idempotency_key text, source_channel text DEFAULT 'storefront',
  payment_status text DEFAULT 'unpaid', order_status text DEFAULT 'pending_payment',
  fulfillment_method text DEFAULT 'shipping',
  courier_provider text, courier_service_code text, courier_service_name text,
  recipient_name text, recipient_phone text, shipping_address jsonb,
  shipping_fee numeric DEFAULT 0, subtotal numeric DEFAULT 0, discount_total numeric DEFAULT 0,
  discount_snapshot jsonb, total_amount numeric DEFAULT 0, currency text DEFAULT 'CNY',
  payment_route jsonb, customer_note text, courier_quote_snapshot jsonb,
  reservation_expires_at timestamptz, provider_transaction_id text, paid_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CONSTRAINT commerce_orders_fulfillment_method_check CHECK (fulfillment_method = ANY (ARRAY['shipping','pickup','carryout'])),
  CONSTRAINT commerce_orders_courier_provider_check CHECK (courier_provider = ANY (ARRAY['sf','cainiao','platform']))
);
CREATE TABLE public.commerce_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, listing_id uuid, sku_id uuid, location_id uuid,
  epc text, title_snapshot text, image_snapshot text, condition_snapshot text, unit_price numeric DEFAULT 0,
  quantity int, line_total numeric DEFAULT 0, discount_total numeric DEFAULT 0,
  discount_snapshot jsonb, ownership_snapshot text, settlement_snapshot jsonb);
CREATE TABLE public.inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, listing_id uuid, sku_id uuid, location_id uuid,
  quantity int, expires_at timestamptz, status text DEFAULT 'active', consumed_at timestamptz);
CREATE TABLE public.inventory_reservation_lines (reservation_id uuid, order_item_id uuid, stock_sku_id uuid, location_id uuid, quantity int);
CREATE TABLE public.commerce_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid,
  payment_channel text, status text, provider_transaction_id text);
CREATE TABLE public.fulfillments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, location_id uuid,
  status text DEFAULT 'allocated', handed_over_at timestamptz, updated_at timestamptz DEFAULT now(),
  UNIQUE (order_id, location_id));
CREATE TABLE public.fulfillment_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, order_item_id uuid,
  sku_id uuid, epc text, expected_qty int CHECK (expected_qty>0), picked_qty int DEFAULT 0, picked_at timestamptz,
  CHECK (picked_qty>=0 AND picked_qty<=expected_qty),
  UNIQUE (fulfillment_id, order_item_id, sku_id));
CREATE TABLE public.fulfillment_shortages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, fulfillment_item_id uuid, quantity int, status text, refund_state text, order_id uuid, refund_intent_id uuid, refund_total_fen int);
CREATE TABLE public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid UNIQUE, provider text,
  service_code text, status text, tracking_no text, carrier_label text,
  idempotency_key text UNIQUE, request_fingerprint text, booked_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());

-- 叶子库存流水：忠实最小实现（真实版额外同步手持端，与被测链路无关）
CREATE OR REPLACE FUNCTION public.inv_apply_movement(p_sku_id uuid, p_location_id uuid, p_delta int, p_ref_type text, p_ref_id uuid, p_epc text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new int;
BEGIN
  INSERT INTO public.inv_stocks (sku_id, location_id, qty) VALUES (p_sku_id, p_location_id, p_delta)
    ON CONFLICT (sku_id, location_id) DO UPDATE SET qty = inv_stocks.qty + EXCLUDED.qty, updated_at = now()
    RETURNING qty INTO v_new;
  INSERT INTO public.inv_stock_movements (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note)
    VALUES (p_sku_id, p_location_id, p_delta, v_new, p_ref_type, p_ref_id, p_epc, p_note);
  RETURN v_new;
END $$;

-- 基础报价夹具：按 items 内容 md5 取回报价 JSON
CREATE TABLE public.quote_fixtures (items_key text PRIMARY KEY, quote jsonb);
CREATE OR REPLACE FUNCTION public.commerce_quote_checkout(p_customer_id uuid, p_items jsonb, p_coupon_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT quote FROM public.quote_fixtures WHERE items_key = md5(p_items::text)
$$;

-- 真实底层函数（pg_get_functiondef 导出原文，不用 stub）
\i tests/sql/flash_cod/real_create_order_v2.sql
\i tests/sql/flash_cod/real_mark_ordinary_order_paid.sql
\i tests/sql/flash_cod/real_assign_customer_trigger.sql
CREATE TRIGGER commerce_assign_storefront_customer BEFORE INSERT OR UPDATE OF user_id, customer_id, source_channel
  ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.commerce_assign_storefront_customer();

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

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
