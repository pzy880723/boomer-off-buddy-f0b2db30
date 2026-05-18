
-- domestic_orders 表
CREATE TABLE public.domestic_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL, -- xianyu | douyin | xiaohongshu | wechat | pinduoduo
  source_order_no text,
  seller_name text,
  seller_handle text,
  item_title text,
  item_image_url text,
  qty integer DEFAULT 1,
  price_cny numeric,
  shipping_cny numeric,
  total_cny numeric,
  purchased_at timestamptz,
  tracking_no text,
  carrier text,
  receiver_name text,
  receiver_phone text,
  receiver_address text,
  status text NOT NULL DEFAULT 'paid', -- pending_pay | paid | shipped | delivered | completed
  chat_summary text,
  notes text,
  screenshot_urls jsonb DEFAULT '[]'::jsonb,
  raw_payload jsonb,
  completeness integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_domestic_orders_platform ON public.domestic_orders(platform);
CREATE INDEX idx_domestic_orders_status ON public.domestic_orders(status);
CREATE INDEX idx_domestic_orders_created_at ON public.domestic_orders(created_at DESC);
CREATE UNIQUE INDEX uq_domestic_orders_platform_orderno
  ON public.domestic_orders(platform, source_order_no)
  WHERE source_order_no IS NOT NULL;

ALTER TABLE public.domestic_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_domestic_orders ON public.domestic_orders FOR SELECT USING (true);
CREATE POLICY open_insert_domestic_orders ON public.domestic_orders FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_domestic_orders ON public.domestic_orders FOR UPDATE USING (true);
CREATE POLICY open_delete_domestic_orders ON public.domestic_orders FOR DELETE USING (true);

CREATE TRIGGER trg_domestic_orders_updated_at
BEFORE UPDATE ON public.domestic_orders
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 截图存储桶
INSERT INTO storage.buckets (id, name, public) VALUES ('domestic-order-screenshots', 'domestic-order-screenshots', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read domestic screenshots"
ON storage.objects FOR SELECT
USING (bucket_id = 'domestic-order-screenshots');

CREATE POLICY "Public upload domestic screenshots"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'domestic-order-screenshots');

CREATE POLICY "Public update domestic screenshots"
ON storage.objects FOR UPDATE
USING (bucket_id = 'domestic-order-screenshots');

CREATE POLICY "Public delete domestic screenshots"
ON storage.objects FOR DELETE
USING (bucket_id = 'domestic-order-screenshots');
