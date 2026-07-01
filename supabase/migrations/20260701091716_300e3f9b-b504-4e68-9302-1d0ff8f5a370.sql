
-- 1) 队列扩列：shop_id / location_id / action
ALTER TABLE public.youzan_stock_sync_queue
  ADD COLUMN IF NOT EXISTS shop_id uuid REFERENCES public.youzan_shops(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'update_stock';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'youzan_stock_sync_queue_action_check'
  ) THEN
    ALTER TABLE public.youzan_stock_sync_queue
      ADD CONSTRAINT youzan_stock_sync_queue_action_check
      CHECK (action IN ('update_stock','create_and_bind','create_branch_listing'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_yz_stock_queue_shop
  ON public.youzan_stock_sync_queue(shop_id);

CREATE INDEX IF NOT EXISTS idx_yz_stock_queue_loc
  ON public.youzan_stock_sync_queue(location_id);

-- 2) 回填：老数据里 shop_id 空，用 sku_youzan_links 里唯一 shop_id 填补（旧数据都是 HQ 单绑）
UPDATE public.youzan_stock_sync_queue q
SET shop_id = l.shop_id
FROM public.sku_youzan_links l
WHERE q.shop_id IS NULL
  AND q.sku_id = l.sku_id;
