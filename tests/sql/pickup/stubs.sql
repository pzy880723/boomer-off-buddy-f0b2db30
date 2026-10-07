-- 自提隔离测试最小结构（只含被测迁移依赖的列）；绝不连接生产库。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE inv_locations (id uuid PRIMARY KEY, kind text NOT NULL, name text, is_active boolean DEFAULT true);
CREATE TABLE user_roles (user_id uuid, role text);
CREATE TABLE user_location_perms (user_id uuid, location_id uuid);
CREATE TABLE commerce_customers (id uuid PRIMARY KEY, status text DEFAULT 'active');
CREATE TABLE commerce_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, customer_id uuid, idempotency_key text,
  source_channel text DEFAULT 'storefront', fulfillment_method text DEFAULT 'shipping',
  payment_status text DEFAULT 'unpaid', order_status text DEFAULT 'pending_payment',
  recipient_name text, recipient_phone text, shipping_address jsonb, courier_provider text, courier_service_code text,
  courier_service_name text, shipping_fee numeric, courier_quote_snapshot jsonb, customer_note text,
  discount_total numeric, discount_snapshot jsonb, total_amount numeric DEFAULT 10, currency text DEFAULT 'CNY',
  payment_route jsonb, completed_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE TABLE fulfillments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES commerce_orders(id),
  location_id uuid, status text DEFAULT 'unallocated', picked_at timestamptz, packed_at timestamptz,
  handed_over_at timestamptz, updated_at timestamptz, UNIQUE(order_id, location_id));
CREATE TABLE fulfillment_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, expected_qty int,
  picked_qty int DEFAULT 0, packed_qty int DEFAULT 0, picked_at timestamptz, packed_at timestamptz);
CREATE TABLE fulfillment_shortages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, status text);
CREATE TABLE commerce_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, status text);
CREATE TABLE commerce_refunds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, status text);
CREATE TABLE commerce_refund_intents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, state text);
CREATE TABLE inv_stock_movements (id serial, note text);
-- 下单依赖（create 用例）
CREATE TABLE pos_customer_coupons (id uuid PRIMARY KEY, customer_id uuid, status text, reserved_order_id uuid, updated_at timestamptz);
CREATE TABLE inv_skus (id uuid PRIMARY KEY, sale_ownership text DEFAULT 'owned', settlement_party_ref text);
CREATE TABLE commerce_listings (id uuid PRIMARY KEY, location_id uuid, sku_id uuid);
CREATE TABLE commerce_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, listing_id uuid, location_id uuid,
  discount_total numeric, discount_snapshot jsonb, line_total numeric DEFAULT 10, ownership_snapshot text, settlement_snapshot jsonb);
CREATE TABLE inventory_reservation_lines (order_item_id uuid, stock_sku_id uuid);
CREATE FUNCTION commerce_quote_checkout(p_customer_id uuid, p_items jsonb, p_coupon_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('version','per_store_99_cross_299_v1','items','[]'::jsonb,
    'groups', jsonb_build_array(jsonb_build_object('location_id','a0000000-0000-4000-8000-000000000001','subtotal_fen',5000,'shipping_fee_fen',990,'remaining_fen',4900)),
    'subtotal_fen',5000,'shipping_fee_fen',990,'total_fen',5990,'coupon',null,'discount_fen',0,'discount_allocations','[]'::jsonb,
    'cross_store_free',false,'cross_store_remaining_fen',0) $$;
CREATE FUNCTION commerce_create_order_v2(p_user_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text,
  p_recipient_phone text, p_shipping_address jsonb, p_courier_provider text, p_courier_service_code text,
  p_courier_service_name text DEFAULT NULL, p_shipping_fee numeric DEFAULT 0, p_quote_snapshot jsonb DEFAULT NULL, p_customer_note text DEFAULT NULL)
RETURNS commerce_orders LANGUAGE plpgsql AS $$ DECLARE v commerce_orders; BEGIN
  INSERT INTO commerce_orders(user_id, customer_id, idempotency_key, recipient_name, recipient_phone, shipping_address,
    courier_provider, courier_service_code, courier_service_name, shipping_fee, courier_quote_snapshot)
  VALUES (p_user_id, p_user_id, p_idempotency_key, p_recipient_name, p_recipient_phone, p_shipping_address,
    p_courier_provider, p_courier_service_code, p_courier_service_name, p_shipping_fee, p_quote_snapshot) RETURNING * INTO v;
  INSERT INTO commerce_order_items(order_id, listing_id, location_id) SELECT v.id, (i->>'listing_id')::uuid, l.location_id
    FROM jsonb_array_elements(p_items) i JOIN commerce_listings l ON l.id=(i->>'listing_id')::uuid;
  RETURN v; END $$;
-- 模拟真实付款确认顺序：先插子单，再置 paid
CREATE FUNCTION test_mark_paid(p_order uuid, p_locations uuid[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l uuid; BEGIN
  PERFORM 1 FROM commerce_orders WHERE id=p_order FOR UPDATE;
  FOREACH l IN ARRAY p_locations LOOP
    INSERT INTO fulfillments(order_id, location_id) VALUES (p_order, l) ON CONFLICT DO NOTHING;
  END LOOP;
  UPDATE commerce_orders SET payment_status='paid', order_status='processing' WHERE id=p_order;
END $$;
INSERT INTO inv_locations VALUES
  ('a0000000-0000-4000-8000-000000000001','shop','A',true),
  ('a0000000-0000-4000-8000-000000000002','shop','B',true),
  ('a0000000-0000-4000-8000-000000000009','warehouse','W',true);
INSERT INTO user_roles VALUES
  ('b0000000-0000-4000-8000-00000000000a','store_staff'),
  ('b0000000-0000-4000-8000-00000000000b','store_staff'),
  ('b0000000-0000-4000-8000-00000000000c','hq_operator'),
  ('b0000000-0000-4000-8000-00000000000e','store_staff');
INSERT INTO user_location_perms VALUES
  ('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4000-8000-00000000000e','a0000000-0000-4000-8000-000000000001');
-- d: 有库位权限但无员工角色
INSERT INTO user_location_perms VALUES ('b0000000-0000-4000-8000-00000000000d','a0000000-0000-4000-8000-000000000001');
