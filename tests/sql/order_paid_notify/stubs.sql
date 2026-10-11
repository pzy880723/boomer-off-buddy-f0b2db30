-- 最小结构桩：仅本测试所需列，无业务数据。
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.inv_locations (id uuid PRIMARY KEY, name text);
CREATE TABLE public.inv_handheld_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  kind text NOT NULL, title text, payload jsonb DEFAULT '{}'::jsonb, ts timestamptz DEFAULT now(),
  user_id uuid, audience text DEFAULT 'location', action_status text, ref_type text, ref_id uuid,
  CONSTRAINT inv_handheld_notifications_kind_check CHECK (kind = ANY (ARRAY['stocktake_assigned','transfer_incoming','youzan_sync_failed','unclaimed_epc_pending','system']))
);
CREATE TABLE public.commerce_orders (
  id uuid PRIMARY KEY, order_no text, source_channel text DEFAULT 'storefront',
  payment_status text DEFAULT 'unpaid', order_status text DEFAULT 'pending_payment',
  paid_at timestamptz, metadata jsonb DEFAULT '{}'::jsonb, fulfillment_method text DEFAULT 'shipping',
  customer_phone text, shipping_address jsonb
);
CREATE TABLE public.fulfillments (
  id uuid PRIMARY KEY, code text, order_id uuid REFERENCES public.commerce_orders(id),
  location_id uuid REFERENCES public.inv_locations(id), status text DEFAULT 'allocated'
);
CREATE TABLE public.commerce_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, location_id uuid, is_gift boolean DEFAULT false);
CREATE TABLE public.handheld_notification_reads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_id uuid REFERENCES public.inv_handheld_notifications(id) ON DELETE CASCADE, user_id uuid NOT NULL, read_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), UNIQUE(notification_id,user_id));
