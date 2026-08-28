-- Add the missing 12.9 price SKU to every existing unlimited standard product group.
-- The migration is additive: existing SKUs, barcodes, images, stock and Youzan links stay unchanged.

DO $$
DECLARE
  v_group_count integer;
  v_inserted_count integer;
  v_price_tiers numeric[] := ARRAY[
    6.9, 9.9, 12.9, 15.9, 19.9, 29.9, 39.9, 49.9, 59.9, 69, 79, 89, 99,
    129, 159, 199, 259, 299, 359, 399, 459, 499, 580, 680, 780, 880, 980,
    1080, 1180, 1280, 1380, 1580
  ]::numeric[];
BEGIN
  SELECT count(*)
    INTO v_group_count
  FROM (
    SELECT category, name
    FROM public.inv_skus
    WHERE kind = 'single'
      AND is_custom_price = false
      AND inventory_policy = 'unlimited'
    GROUP BY category, name
  ) standard_groups;

  IF v_group_count = 0 THEN
    RAISE EXCEPTION 'No unlimited standard product groups found';
  END IF;

  WITH templates AS (
    SELECT DISTINCT ON (sku.category, sku.name)
      sku.category,
      sku.name,
      sku.sku_code,
      sku.epc,
      sku.weight_g,
      sku.image_url,
      sku.image_paths,
      sku.notes,
      sku.attributes,
      sku.status,
      sku.is_display,
      sku.default_shop_ids,
      sku.category_source,
      sku.classification_status
    FROM public.inv_skus sku
    WHERE sku.kind = 'single'
      AND sku.is_custom_price = false
      AND sku.inventory_policy = 'unlimited'
    ORDER BY
      sku.category,
      sku.name,
      CASE WHEN sku.price_tier = 9.9 THEN 0 ELSE 1 END,
      sku.price_tier
  )
  INSERT INTO public.inv_skus (
    category,
    name,
    sku_code,
    price_tier,
    is_custom_price,
    kind,
    pack_pieces,
    epc,
    weight_g,
    image_url,
    image_paths,
    stock_qty,
    notes,
    attributes,
    status,
    is_display,
    inventory_policy,
    default_shop_ids,
    category_source,
    classification_status
  )
  SELECT
    template.category,
    template.name,
    template.sku_code,
    12.9,
    false,
    'single',
    NULL,
    CASE
      WHEN template.epc ~ '-[0-9]{5}-'
        THEN regexp_replace(template.epc, '-[0-9]{5}-', '-00129-')
      ELSE 'STD-129-' || upper(substr(md5(
        template.category || '|' || template.name || '|' || coalesce(template.sku_code, '')
      ), 1, 16))
    END,
    template.weight_g,
    template.image_url,
    coalesce(template.image_paths, ARRAY[]::text[]),
    0,
    template.notes,
    coalesce(template.attributes, '{}'::jsonb),
    template.status,
    template.is_display,
    'unlimited',
    coalesce(template.default_shop_ids, ARRAY[]::uuid[]),
    coalesce(template.category_source, 'legacy'),
    coalesce(template.classification_status, 'legacy')
  FROM templates template
  ON CONFLICT (category, price_tier, name) WHERE (is_custom_price = false) DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  IF v_inserted_count NOT IN (0, v_group_count) THEN
    RAISE EXCEPTION 'Expected to insert 0 or % standard 12.9 SKUs, inserted %',
      v_group_count, v_inserted_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        category,
        name,
        count(DISTINCT price_tier) AS tier_count,
        bool_or(price_tier = 12.9) AS has_12_9
      FROM public.inv_skus
      WHERE kind = 'single'
        AND is_custom_price = false
        AND inventory_policy = 'unlimited'
      GROUP BY category, name
    ) standard_group
    WHERE standard_group.tier_count <> 32
       OR standard_group.has_12_9 = false
  ) THEN
    RAISE EXCEPTION 'Every unlimited standard product group must contain 32 tiers including 12.9';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.inv_skus
    WHERE kind = 'single'
      AND is_custom_price = false
      AND inventory_policy = 'unlimited'
      AND price_tier = 12.9
      AND barcode IS NULL
  ) THEN
    RAISE EXCEPTION 'Every standard 12.9 SKU must have a generated barcode';
  END IF;

  INSERT INTO public.app_settings(key, value, updated_at)
  VALUES ('inv_price_tiers', to_jsonb(v_price_tiers), now())
  ON CONFLICT (key) DO UPDATE
    SET value = excluded.value,
        updated_at = excluded.updated_at;
END $$;
