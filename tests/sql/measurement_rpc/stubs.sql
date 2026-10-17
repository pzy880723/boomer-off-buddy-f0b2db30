-- 尺寸测量 RPC 最小结构桩：仅本测试所需列，无业务数据。
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.inv_locations (id uuid PRIMARY KEY, name text);

CREATE TABLE public.inv_skus (
  id uuid PRIMARY KEY,
  name text,
  location_id uuid REFERENCES public.inv_locations(id),
  measurement_height_cm numeric(8,2),
  measurement_width_cm numeric(8,2),
  measurement_depth_cm numeric(8,2),
  measurement_diameter_cm numeric(8,2),
  measured_by uuid,
  measured_at timestamptz,
  measurement_revision integer NOT NULL DEFAULT 0
);

CREATE TABLE public.commerce_listings (
  id uuid PRIMARY KEY,
  sku_id uuid REFERENCES public.inv_skus(id),
  location_id uuid REFERENCES public.inv_locations(id),
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz
);

CREATE TABLE public.commerce_customers (id uuid PRIMARY KEY, external_subject text);

CREATE TABLE public.product_measurement_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  listing_id uuid REFERENCES public.commerce_listings(id),
  location_id uuid REFERENCES public.inv_locations(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','cancelled')),
  claimed_by uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_measurement_tasks_active_sku
  ON public.product_measurement_tasks (sku_id) WHERE status IN ('pending','claimed');

CREATE TABLE public.product_measurement_requesters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.product_measurement_tasks(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, customer_id)
);

CREATE TABLE public.product_measurement_assets (
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  revision integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cutout_preview_path text,
  bbox jsonb,
  front_width_px integer,
  front_height_px integer,
  px_per_cm numeric(10,3),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, revision)
);

CREATE TABLE public.inv_handheld_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text,
  payload jsonb DEFAULT '{}'::jsonb,
  ts timestamptz DEFAULT now(),
  user_id uuid,
  audience text DEFAULT 'location',
  action_status text,
  ref_type text,
  ref_id uuid
);

CREATE TABLE public.commerce_customer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.commerce_customers(id),
  kind text,
  title text,
  body text,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX commerce_customer_notifications_dedupe
  ON public.commerce_customer_notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

INSERT INTO public.inv_locations VALUES
  ('00000000-0000-0000-0000-00000000000a','A店'),
  ('00000000-0000-0000-0000-00000000000b','B店');
INSERT INTO public.inv_skus (id, name, location_id) VALUES
  ('00000000-0000-0000-0000-000000000001','奥特曼软胶','00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-000000000002','已测商品','00000000-0000-0000-0000-00000000000b');
INSERT INTO public.commerce_listings (id, sku_id, location_id, status, published_at) VALUES
  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','published',now()),
  ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','published',now()),
  ('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','draft',null);
INSERT INTO public.commerce_customers VALUES
  ('00000000-0000-0000-0000-000000000021','subA'),
  ('00000000-0000-0000-0000-000000000022','subB');
-- s2 已有实测
UPDATE public.inv_skus SET measurement_height_cm=10, measured_at=now(), measurement_revision=1
 WHERE id='00000000-0000-0000-0000-000000000002';
