
-- 改成 (sku_id, shop_id) 唯一，允许同一本地 SKU 在不同店各绑一条
ALTER TABLE public.sku_youzan_links
  DROP CONSTRAINT IF EXISTS sku_youzan_links_sku_id_key;

ALTER TABLE public.sku_youzan_links
  ADD CONSTRAINT sku_youzan_links_sku_shop_key UNIQUE (sku_id, shop_id);
