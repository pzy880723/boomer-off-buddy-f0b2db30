-- 1) 13 个业务一级类目统一 kind='category'
UPDATE public.inv_categories
SET kind = 'category', is_active = true
WHERE parent_id IS NULL
  AND code IN (
    'porcelain_jp','porcelain_eu','toy_model','character_ip_goods','audio_media',
    'digital_appliance','game_device','home_goods','stationery_publication',
    'fashion_wearable','fashion_jewelry','art_collectible','daily_misc'
  )
  AND (kind IS DISTINCT FROM 'category' OR is_active IS DISTINCT FROM true);

-- 2) 挂单行补齐 4 个快照列
ALTER TABLE public.pos_held_cart_items
  ADD COLUMN IF NOT EXISTS category_code text,
  ADD COLUMN IF NOT EXISTS category_name_snapshot text,
  ADD COLUMN IF NOT EXISTS subcategory_code text,
  ADD COLUMN IF NOT EXISTS subcategory_name_snapshot text;

-- 3) 历史数据迁移：subcategory_name -> subcategory_name_snapshot（不造假、不填充默认值）
UPDATE public.pos_held_cart_items
SET subcategory_name_snapshot = subcategory_name
WHERE subcategory_name_snapshot IS NULL
  AND subcategory_name IS NOT NULL;