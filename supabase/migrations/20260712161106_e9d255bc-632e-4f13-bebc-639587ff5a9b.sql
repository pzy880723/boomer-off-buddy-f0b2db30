
-- 1) 分店线下渠道重命名：youzan_offline → youzan_branch_offline（更明确）
UPDATE public.sku_channel_listings SET channel = 'youzan_branch_offline' WHERE channel = 'youzan_offline';
UPDATE public.channel_sync_outbox   SET channel = 'youzan_branch_offline' WHERE channel = 'youzan_offline';

-- 2) 加“已核对到分店的库存版本号”，用于对账 + version guard 判定
ALTER TABLE public.sku_channel_listings
  ADD COLUMN IF NOT EXISTS verified_inventory_version bigint NOT NULL DEFAULT 0;

-- 3) 明确记录分店线下门店销售渠道 id（与 sell_channel_id 兼容，语义更清）
ALTER TABLE public.youzan_shops
  ADD COLUMN IF NOT EXISTS offline_sell_channel_id bigint;

-- 兼容旧字段：把已存的 sell_channel_id 回填到 offline_sell_channel_id
UPDATE public.youzan_shops
   SET offline_sell_channel_id = sell_channel_id
 WHERE offline_sell_channel_id IS NULL AND sell_channel_id IS NOT NULL;
