-- 翻筐乐分筐/赠礼隔离测试最小结构；绝不连接生产库。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE TYPE app_role AS ENUM ('super_admin','hq_operator','store_manager','store_staff','warehouse_staff');
CREATE TABLE user_roles (user_id uuid, role app_role);
CREATE FUNCTION has_role(_user_id uuid, _role app_role) RETURNS boolean LANGUAGE sql AS
  $$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id=_user_id AND role=_role) $$;
CREATE TABLE user_location_perms (user_id uuid, location_id uuid);
CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());
CREATE TABLE inv_locations (id uuid PRIMARY KEY, kind text DEFAULT 'store', name text);
CREATE TABLE commerce_customers (id uuid PRIMARY KEY, status text DEFAULT 'active');
CREATE TABLE inv_skus (id uuid PRIMARY KEY, status text DEFAULT 'active', is_custom_price boolean DEFAULT true,
  inventory_policy text DEFAULT 'tracked', kind text DEFAULT 'single', fankuang_override boolean,
  price_tier numeric DEFAULT 20, is_display boolean DEFAULT true);
CREATE TABLE inv_stocks (sku_id uuid, location_id uuid, qty int, PRIMARY KEY (sku_id, location_id));
CREATE TABLE commerce_listings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, location_id uuid,
  status text DEFAULT 'published', published_at timestamptz DEFAULT now());
CREATE TABLE commerce_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, idempotency_key text UNIQUE,
  payment_status text DEFAULT 'unpaid', order_status text DEFAULT 'pending_payment', paid_at timestamptz,
  fulfillment_method text DEFAULT 'shipping', created_at timestamptz DEFAULT now());
CREATE TABLE commerce_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, listing_id uuid,
  sku_id uuid, location_id uuid, quantity int);
CREATE TABLE fulfillments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, location_id uuid);

-- 现网下单函数替身：同签名、按幂等键重放；recipient_name='FAIL' 模拟下单失败。
CREATE FUNCTION commerce_create_ordinary_order(p_customer_id uuid, p_idempotency_key text, p_items jsonb,
  p_recipient_name text, p_recipient_phone text, p_shipping_address jsonb, p_courier_provider text,
  p_courier_service_code text, p_courier_service_name text, p_shipping_fee numeric, p_quote_snapshot jsonb,
  p_customer_note text, p_merchant_id text, p_app_id text, p_owned_location_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE o commerce_orders; e jsonb;
BEGIN
  SELECT * INTO o FROM commerce_orders WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN to_jsonb(o); END IF;
  IF p_recipient_name='FAIL' THEN RAISE EXCEPTION 'listing not available'; END IF;
  INSERT INTO commerce_orders(customer_id, idempotency_key) VALUES (p_customer_id, p_idempotency_key) RETURNING * INTO o;
  FOR e IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO commerce_order_items(order_id, listing_id, sku_id, location_id, quantity)
    SELECT o.id, l.id, l.sku_id, l.location_id, COALESCE((e->>'quantity')::int,1)
    FROM commerce_listings l WHERE l.id=(e->>'listing_id')::uuid;
  END LOOP;
  RETURN to_jsonb(o);
END $$;
CREATE FUNCTION commerce_create_ordinary_pickup_order(p_customer_id uuid, p_idempotency_key text, p_items jsonb,
  p_recipient_name text, p_recipient_phone text, p_quote_snapshot jsonb, p_customer_note text,
  p_merchant_id text, p_app_id text, p_owned_location_ids uuid[]) RETURNS jsonb
LANGUAGE sql AS $$ SELECT commerce_create_ordinary_order(p_customer_id, p_idempotency_key, p_items, p_recipient_name,
  p_recipient_phone, '{}'::jsonb, 'platform', 'STORE_PICKUP', NULL, 0, p_quote_snapshot, p_customer_note,
  p_merchant_id, p_app_id, p_owned_location_ids) $$;
