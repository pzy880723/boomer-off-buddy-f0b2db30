
ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS sku_scope text NOT NULL DEFAULT 'standard'
    CHECK (sku_scope IN ('standard','custom'));

-- 回填历史数据：自定义价 / 组合装 视为 custom
UPDATE public.inv_skus SET sku_scope = 'custom'
  WHERE (is_custom_price = true OR kind = 'pack') AND sku_scope = 'standard';

-- 插入时按 is_custom_price / kind 自动推导（可后续 UI 修改）
CREATE OR REPLACE FUNCTION public.tg_inv_skus_derive_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_custom_price = true OR NEW.kind = 'pack' THEN
    NEW.sku_scope := 'custom';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inv_skus_derive_scope ON public.inv_skus;
CREATE TRIGGER trg_inv_skus_derive_scope
  BEFORE INSERT ON public.inv_skus
  FOR EACH ROW EXECUTE FUNCTION public.tg_inv_skus_derive_scope();

-- 清理旧的失败绑定 & 队列，让新逻辑自愈重跑
DELETE FROM public.sku_youzan_links
  WHERE role = 'branch_stock'
    AND (yz_item_id = 0 OR status = 'error');

UPDATE public.youzan_stock_sync_queue
  SET status = 'pending',
      attempts = 0,
      next_run_at = now(),
      last_error = NULL
  WHERE status IN ('failed','running');
