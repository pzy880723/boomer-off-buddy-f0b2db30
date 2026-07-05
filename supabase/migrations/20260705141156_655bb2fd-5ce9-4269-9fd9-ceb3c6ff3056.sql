-- 删除 inv_categories 上所有有赞绑定字段（用户决定：类目遵循本地 ERP，不再和有赞分组绑定）
ALTER TABLE public.inv_categories
  DROP CONSTRAINT IF EXISTS inv_categories_youzan_shop_id_fkey;

ALTER TABLE public.inv_categories
  DROP COLUMN IF EXISTS youzan_hq_group_id,
  DROP COLUMN IF EXISTS youzan_hq_group_parent_id,
  DROP COLUMN IF EXISTS youzan_shop_id,
  DROP COLUMN IF EXISTS synced_at;

-- app_settings 里保留 youzan_hq_default_category_id（同步 SPU 时统一用它当兜底分组）；
-- 清理任何 shop_id 特化的默认分组条目（如果之前有过按店铺分的旧值）
DELETE FROM public.app_settings
 WHERE key LIKE 'youzan_hq_default_category_id:%';