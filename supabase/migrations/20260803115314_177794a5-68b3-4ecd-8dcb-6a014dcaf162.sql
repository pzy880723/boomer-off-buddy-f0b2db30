-- 停用商品类目永久清理：先迁移业务引用，再删除全部 is_active=false 类目
DO $$
DECLARE
  m RECORD;
  legacy TEXT[] := ARRAY['jp_porcelain','eu_porcelain','vintage_toy','anime_goods','media','digital','jewelry','fashion','daily','antique'];
BEGIN
  FOR m IN
    SELECT * FROM (VALUES
      ('jp_porcelain','porcelain'),
      ('eu_porcelain','porcelain'),
      ('vintage_toy','toy_model'),
      ('anime_goods','character_ip_goods'),
      ('media','audio_media'),
      ('digital','digital_appliance'),
      ('jewelry','fashion_jewelry'),
      ('fashion','fashion_wearable'),
      ('daily','daily_misc'),
      ('antique','art_collectible')
    ) AS t(old_code, new_code)
  LOOP
    UPDATE public.inv_skus SET category = m.new_code, updated_at = now() WHERE category = m.old_code;

    UPDATE public.inv_sku_classifications SET category_code = m.new_code WHERE category_code = m.old_code;
    UPDATE public.inv_sku_classifications SET predicted_category_code = m.new_code WHERE predicted_category_code = m.old_code;
    UPDATE public.inv_sku_classifications SET corrected_category_code = m.new_code WHERE corrected_category_code = m.old_code;

    UPDATE public.inv_brands
       SET category_codes = (
         SELECT ARRAY(SELECT DISTINCT CASE WHEN c = m.old_code THEN m.new_code ELSE c END
                      FROM unnest(category_codes) AS c))
     WHERE category_codes @> ARRAY[m.old_code];

    UPDATE public.inv_facets
       SET category_codes = (
         SELECT ARRAY(SELECT DISTINCT CASE WHEN c = m.old_code THEN m.new_code ELSE c END
                      FROM unnest(category_codes) AS c))
     WHERE category_codes @> ARRAY[m.old_code];
  END LOOP;

  -- 兜底：任何仍指向不存在类目代码的 SKU 归到待归类
  UPDATE public.inv_skus s
     SET category = 'classification_pending', updated_at = now()
   WHERE NOT EXISTS (SELECT 1 FROM public.inv_categories c WHERE c.code = s.category);

  PERFORM 1 FROM public.inv_skus WHERE category = ANY(legacy);
  IF FOUND THEN
    RAISE EXCEPTION '仍有 SKU 引用旧类目代码，终止删除';
  END IF;
END $$;

-- 永久删除全部停用类目（先解绑子类目引用，避免外键阻塞）
UPDATE public.inv_categories child
   SET parent_id = NULL
 WHERE parent_id IN (SELECT id FROM public.inv_categories WHERE is_active = false)
   AND child.is_active = true;

DELETE FROM public.inv_categories WHERE is_active = false;