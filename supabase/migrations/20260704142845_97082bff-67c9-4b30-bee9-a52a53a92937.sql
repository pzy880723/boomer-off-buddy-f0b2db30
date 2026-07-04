
-- 1. 为每家有赞门店自动映射一个 inv_locations（kind='shop'），
--    这样"每门店独立库存"可以直接用 inv_stocks(sku_id, location_id, qty)。
INSERT INTO public.inv_locations (kind, name, shop_id, is_active)
SELECT 'shop', s.shop_name, s.id, true
FROM public.youzan_shops s
WHERE s.role = 'branch'
  AND NOT EXISTS (
    SELECT 1 FROM public.inv_locations l WHERE l.shop_id = s.id
  );

-- 已存在但被误置为 inactive 的门店 location 一次性打开
UPDATE public.inv_locations
SET is_active = true
WHERE kind = 'shop' AND is_active = false
  AND shop_id IN (SELECT id FROM public.youzan_shops WHERE role = 'branch');

-- 2. 新增/激活分店 kdt 时，自动创建对应 shop location
CREATE OR REPLACE FUNCTION public.tg_youzan_shop_ensure_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'branch' THEN
    INSERT INTO public.inv_locations (kind, name, shop_id, is_active)
    SELECT 'shop', NEW.shop_name, NEW.id, true
    WHERE NOT EXISTS (SELECT 1 FROM public.inv_locations WHERE shop_id = NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_youzan_shop_ensure_location ON public.youzan_shops;
CREATE TRIGGER trg_youzan_shop_ensure_location
AFTER INSERT OR UPDATE OF role, shop_name ON public.youzan_shops
FOR EACH ROW EXECUTE FUNCTION public.tg_youzan_shop_ensure_location();

-- 3. 新的自动上架队列：SKU 在某家分店首次有库存时，写一条 pending 记录，
--    由后端 serverFn 或后台任务读取 → 调有赞 item.add → 写回 yz_item_id。
--    复用现有 sku_youzan_links 表，新增 auto_listing_status 语义。
--    这里只补一个索引，方便按门店拉未上架列表。
CREATE INDEX IF NOT EXISTS idx_sku_youzan_links_shop_status
  ON public.sku_youzan_links (shop_id, status);
