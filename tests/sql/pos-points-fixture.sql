-- Disposable PGlite fixture. Production sale/discount/return functions are loaded by the test.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE user_roles(user_id uuid,role text);
CREATE TABLE inv_locations(id uuid PRIMARY KEY);
CREATE TABLE commerce_customers(id uuid PRIMARY KEY, status text DEFAULT 'active');
CREATE TABLE pos_registers(id uuid PRIMARY KEY, receipt_prefix text DEFAULT 'TEST');
CREATE TABLE pos_shifts(id uuid PRIMARY KEY, location_id uuid, operator_id uuid, status text DEFAULT 'open', register_id uuid);
CREATE TABLE inv_categories(id uuid PRIMARY KEY, code text, name text, parent_id uuid, is_active boolean DEFAULT true);
CREATE TABLE inv_skus(id uuid PRIMARY KEY, name text DEFAULT 'test', price_tier numeric(12,2),
  status text DEFAULT 'active', is_display boolean DEFAULT true, kind text DEFAULT 'single',
  is_custom_price boolean DEFAULT false, inventory_policy text DEFAULT 'tracked', epc text,
  bundle_items jsonb, category text, image_url text, grade text, sales_state text, updated_at timestamptz);
CREATE TABLE inv_stocks(sku_id uuid,location_id uuid,qty integer,PRIMARY KEY(sku_id,location_id));
CREATE TABLE inv_epcs(epc text,status text,current_location_id uuid,last_seen_at timestamptz);
CREATE TABLE commerce_listings(id uuid,sku_id uuid,status text,sold_at timestamptz,updated_at timestamptz);
CREATE TABLE commerce_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_no text DEFAULT gen_random_uuid()::text,
  user_id uuid,source_channel text,fulfillment_method text,sale_location_id uuid,operator_id uuid,customer_id uuid,
  pos_shift_id uuid,payment_status text,order_status text,subtotal numeric(12,2),total_amount numeric(12,2),
  recipient_name text,recipient_phone text,shipping_address text,courier_provider text,courier_service_code text,
  idempotency_key text UNIQUE,reservation_expires_at timestamptz,paid_at timestamptz,completed_at timestamptz,
  customer_note text,metadata jsonb DEFAULT '{}',updated_at timestamptz);
CREATE TABLE commerce_order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,listing_id uuid,
  sku_id uuid,location_id uuid,epc text,title_snapshot text,image_snapshot text,condition_snapshot text,
  unit_price numeric(12,2),quantity integer,line_total numeric(12,2),category_code text,category_name_snapshot text,
  subcategory_code text,subcategory_name_snapshot text,created_at timestamptz DEFAULT now());
CREATE TABLE commerce_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,provider text,status text,
  amount numeric(12,2),provider_transaction_id text,idempotency_key text,paid_at timestamptz);
CREATE TABLE commerce_payment_events(payment_id uuid,provider text,provider_event_id text,event_type text,
  signature_verified boolean,payload jsonb,processing_status text,processed_at timestamptz);
CREATE TABLE pos_cash_movements(shift_id uuid,order_id uuid,type text,amount numeric(12,2),reason text,operator_id uuid);
CREATE TABLE pos_receipts(order_id uuid,shift_id uuid,receipt_no text,payload jsonb);
CREATE TABLE commerce_membership_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text,tier_code text,
  is_active boolean DEFAULT true,points_redemption_cap_rate numeric(6,4),policy_version integer DEFAULT 1);
CREATE TABLE commerce_membership_entitlements(id uuid DEFAULT gen_random_uuid(),customer_id uuid,plan_id uuid,
  status text DEFAULT 'active',starts_at timestamptz DEFAULT now(),expires_at timestamptz);
CREATE TABLE commerce_points_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,delta integer CHECK(delta<>0),
  balance_after integer CHECK(balance_after>=0),source_type text,source_id text,idempotency_key text UNIQUE,metadata jsonb);
CREATE FUNCTION sales_sku_available_qty(p_sku_id uuid,p_location_id uuid) RETURNS integer LANGUAGE sql AS $$
 SELECT qty FROM inv_stocks WHERE sku_id=p_sku_id AND location_id=p_location_id
$$;
CREATE FUNCTION inv_apply_movement(p_sku_id uuid,p_location_id uuid,p_qty integer,p_type text,p_id uuid,p_epc text,p_op text)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  UPDATE inv_stocks SET qty=qty+p_qty WHERE sku_id=p_sku_id AND location_id=p_location_id;
  IF EXISTS(SELECT 1 FROM inv_stocks WHERE qty<0) THEN RAISE EXCEPTION 'insufficient stock'; END IF;
END $$;
