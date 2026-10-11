DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.inv_locations (id uuid PRIMARY KEY, kind text DEFAULT 'shop', is_active boolean DEFAULT true);
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.user_location_perms (user_id uuid, location_id uuid);
CREATE TABLE public.commerce_orders (id uuid PRIMARY KEY, payment_status text, order_status text, fulfillment_method text);
CREATE TABLE public.fulfillments (id uuid PRIMARY KEY, order_id uuid, location_id uuid, status text, handed_over_at timestamptz, updated_at timestamptz);
CREATE TABLE public.fulfillment_items (id uuid PRIMARY KEY, fulfillment_id uuid, expected_qty int CHECK (expected_qty>0), picked_qty int DEFAULT 0, picked_at timestamptz, CHECK (picked_qty>=0 AND picked_qty<=expected_qty));
CREATE TABLE public.fulfillment_shortages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, fulfillment_item_id uuid, quantity int CHECK (quantity>0), status text, refund_state text, order_id uuid, refund_intent_id uuid, refund_total_fen int);
CREATE TABLE public.commerce_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, status text, amount numeric);
CREATE TABLE public.commerce_refunds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, payment_id uuid, after_sale_id uuid, status text, amount numeric);
CREATE TABLE public.commerce_refund_intents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shortage_id uuid, order_id uuid, payment_id uuid, after_sale_id uuid, refund_id uuid, amount_fen int, state text);
CREATE TABLE public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid UNIQUE, provider text CHECK (provider IN ('sf','cainiao')),
  service_code text, status text, tracking_no text, idempotency_key text UNIQUE, booked_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
