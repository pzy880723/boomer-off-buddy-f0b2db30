ALTER TABLE public.youzan_orders
  ADD COLUMN IF NOT EXISTS buyer_open_id text,
  ADD COLUMN IF NOT EXISTS item_count integer,
  ADD COLUMN IF NOT EXISTS sku_count integer,
  ADD COLUMN IF NOT EXISTS item_titles text,
  ADD COLUMN IF NOT EXISTS first_item_image text,
  ADD COLUMN IF NOT EXISTS receiver_name text,
  ADD COLUMN IF NOT EXISTS receiver_tel text,
  ADD COLUMN IF NOT EXISTS receiver_address text,
  ADD COLUMN IF NOT EXISTS outer_transaction_no text,
  ADD COLUMN IF NOT EXISTS post_fee numeric,
  ADD COLUMN IF NOT EXISTS status_text text;

CREATE INDEX IF NOT EXISTS idx_youzan_orders_shop_pay_time ON public.youzan_orders (shop_id, pay_time DESC);
CREATE INDEX IF NOT EXISTS idx_youzan_orders_shop_status ON public.youzan_orders (shop_id, status);