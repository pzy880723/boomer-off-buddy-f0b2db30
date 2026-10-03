-- Optional preference labels only; no product, price, stock, or selection defaults.
-- Keep existing codes and all existing row values, including disabled labels.
DO $$
DECLARE
  v_roots constant text[] := ARRAY[
    'porcelain_jp', 'porcelain_eu', 'porcelain_cartoon', 'toy_model',
    'character_ip_goods', 'audio_media', 'digital_appliance', 'game_device',
    'home_goods', 'stationery_publication', 'fashion_wearable', 'fashion_jewelry',
    'art_collectible', 'daily_misc'
  ];
  v_root_code text;
  v_parent public.inv_categories%ROWTYPE;
  v_label record;
BEGIN
  -- Serialize taxonomy writes so the parent check and insert cannot race a reparent.
  LOCK TABLE public.inv_categories IN SHARE ROW EXCLUSIVE MODE;

  FOREACH v_root_code IN ARRAY v_roots LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.inv_categories
      WHERE code = v_root_code AND parent_id IS NULL
        AND is_active AND kind = 'category'
    ) THEN
      RAISE EXCEPTION 'subcategory_root_unavailable: %', v_root_code;
    END IF;
  END LOOP;

  FOR v_label IN
    SELECT * FROM (VALUES
      ('porcelain_cartoon_drinkware', '杯具', 'porcelain_cartoon', 1),
      ('porcelain_cartoon_plate', '盘碟', 'porcelain_cartoon', 2),
      ('porcelain_cartoon_bowl', '碗钵', 'porcelain_cartoon', 3),
      ('porcelain_cartoon_teaware', '壶/茶具', 'porcelain_cartoon', 4),
      ('porcelain_cartoon_storage', '储物罐', 'porcelain_cartoon', 5),
      ('porcelain_cartoon_vase_ornament', '花器/摆件', 'porcelain_cartoon', 6),
      ('porcelain_cartoon_set', '套装/礼盒', 'porcelain_cartoon', 7),
      ('game_disc', '游戏光盘', 'game_device', 5)
    ) AS labels(code, name, parent_code, ordinal)
  LOOP
    SELECT * INTO STRICT v_parent
    FROM public.inv_categories WHERE code = v_label.parent_code;

    IF EXISTS (
      SELECT 1 FROM public.inv_categories
      WHERE code = v_label.code AND parent_id IS DISTINCT FROM v_parent.id
    ) THEN
      RAISE EXCEPTION 'subcategory_parent_conflict: % expected parent %',
        v_label.code, v_label.parent_code;
    END IF;

    INSERT INTO public.inv_categories (
      code, name, parent_id, sort_order, is_active, is_system, kind
    ) VALUES (
      v_label.code, v_label.name, v_parent.id,
      v_parent.sort_order + v_label.ordinal, true, false, 'category'
    )
    ON CONFLICT (code) DO NOTHING;
  END LOOP;

  FOREACH v_root_code IN ARRAY v_roots LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.inv_categories p
      JOIN public.inv_categories c ON c.parent_id = p.id
      WHERE p.code = v_root_code AND c.is_active
        AND c.kind = 'category'
    ) THEN
      RAISE EXCEPTION 'subcategory_root_without_labels: %', v_root_code;
    END IF;
  END LOOP;
END $$;
