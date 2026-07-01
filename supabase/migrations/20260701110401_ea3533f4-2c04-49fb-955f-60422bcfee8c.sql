
-- v2 有赞同步模型：明确 HQ 只作 SPU 主数据、分店才推库存
ALTER TABLE public.sku_youzan_links
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'branch_stock'
    CHECK (role IN ('hq_spu','branch_stock')),
  ADD COLUMN IF NOT EXISTS sync_stock boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.sku_youzan_links.role IS 'hq_spu = 只作 SPU 主数据不同步库存 ; branch_stock = 分店库存 1:1 同步';
COMMENT ON COLUMN public.sku_youzan_links.sync_stock IS 'false 时 worker 跳过任何 push_stock 任务';

-- 触发器：绑定时根据 youzan_shops.role 自动决定 link.role & sync_stock
CREATE OR REPLACE FUNCTION public.tg_sku_youzan_links_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shop_role text;
BEGIN
  SELECT role INTO v_shop_role FROM public.youzan_shops WHERE id = NEW.shop_id;
  IF v_shop_role = 'hq' THEN
    NEW.role := 'hq_spu';
    NEW.sync_stock := false;
  ELSE
    NEW.role := COALESCE(NEW.role, 'branch_stock');
    NEW.sync_stock := COALESCE(NEW.sync_stock, true);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_sku_youzan_links_role ON public.sku_youzan_links;
CREATE TRIGGER tg_sku_youzan_links_role
BEFORE INSERT OR UPDATE OF shop_id ON public.sku_youzan_links
FOR EACH ROW EXECUTE FUNCTION public.tg_sku_youzan_links_role();

-- queue.action 允许更多类型（保持 text，无 CHECK 便于演进）
COMMENT ON COLUMN public.youzan_stock_sync_queue.action IS 'update_stock | push_stock | create_branch_item | create_hq_item';
