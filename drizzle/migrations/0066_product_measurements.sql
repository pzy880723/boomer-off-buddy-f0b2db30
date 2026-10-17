ALTER TABLE public.inv_skus
  ADD COLUMN measurement_height_cm numeric(8,2),
  ADD COLUMN measurement_width_cm numeric(8,2),
  ADD COLUMN measurement_depth_cm numeric(8,2),
  ADD COLUMN measurement_diameter_cm numeric(8,2),
  ADD COLUMN measured_by uuid,
  ADD COLUMN measured_at timestamptz,
  ADD COLUMN measurement_revision integer NOT NULL DEFAULT 0;

ALTER TABLE public.inv_skus
  ADD CONSTRAINT inv_skus_measurement_positive CHECK (
    (measurement_height_cm IS NULL OR measurement_height_cm > 0)
    AND (measurement_width_cm IS NULL OR measurement_width_cm > 0)
    AND (measurement_depth_cm IS NULL OR measurement_depth_cm > 0)
    AND (measurement_diameter_cm IS NULL OR measurement_diameter_cm > 0)
  );

COMMENT ON COLUMN public.inv_skus.measurement_height_cm IS '实测高度(cm)，仅人工实测填写，禁止写入 AI 估算值';
COMMENT ON COLUMN public.inv_skus.measurement_revision IS '尺寸版本号，每次保存实测 +1；尺寸素材按版本归属，旧版本任务不得覆盖';

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
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
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

GRANT ALL ON public.product_measurement_tasks TO service_role;
GRANT ALL ON public.product_measurement_requesters TO service_role;
GRANT ALL ON public.product_measurement_assets TO service_role;

ALTER TABLE public.product_measurement_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_measurement_requesters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_measurement_assets ENABLE ROW LEVEL SECURITY;