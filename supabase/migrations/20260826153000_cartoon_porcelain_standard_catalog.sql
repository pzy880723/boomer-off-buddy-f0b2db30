-- Add 卡通瓷器 as one standard product with the canonical 31 price SKUs.
-- Existing standard products, barcodes, stock and Youzan links are untouched.

INSERT INTO public.inv_categories (
  code,
  name,
  parent_id,
  sort_order,
  is_active,
  is_system,
  kind,
  updated_at
)
VALUES (
  'porcelain_cartoon',
  '卡通瓷器',
  NULL,
  25,
  true,
  false,
  'category',
  now()
)
ON CONFLICT (code) DO UPDATE
SET name = excluded.name,
    parent_id = NULL,
    sort_order = excluded.sort_order,
    is_active = true,
    kind = 'category',
    updated_at = now();

DO $$
DECLARE
  v_price_tiers numeric[] := ARRAY[
    6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9, 59.9, 69, 79, 89, 99, 129, 159,
    199, 259, 299, 359, 399, 459, 499, 580, 680, 780, 880, 980, 1080, 1180,
    1280, 1380, 1580
  ]::numeric[];
BEGIN
  IF array_length(v_price_tiers, 1) <> 31 THEN
    RAISE EXCEPTION 'Cartoon porcelain standard catalog must contain exactly 31 price tiers';
  END IF;

  INSERT INTO public.inv_skus (
    category,
    name,
    sku_code,
    price_tier,
    is_custom_price,
    kind,
    epc,
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
    'porcelain_cartoon',
    '卡通瓷器',
    'SKU-STD-CP',
    tier.price,
    false,
    'single',
    'STD-CP-' || lpad((tier.price * 10)::integer::text, 5, '0') || '-' ||
      upper(substr(md5('porcelain_cartoon|卡通瓷器|' || tier.price::text), 1, 8)),
    ARRAY['sku-listing/standard-catalog/2026-08-26/SKU-STD-CP.jpg']::text[],
    0,
    '卡通瓷器标准商品',
    jsonb_build_object('standard_group', 'porcelain_cartoon'),
    'active',
    true,
    'unlimited',
    ARRAY[]::uuid[],
    'legacy',
    'legacy'
  FROM unnest(v_price_tiers) AS tier(price)
  ON CONFLICT (category, price_tier, name) WHERE (is_custom_price = false) DO UPDATE
  SET sku_code = excluded.sku_code,
      is_custom_price = false,
      kind = 'single',
      status = 'active',
      is_display = true,
      inventory_policy = 'unlimited',
      image_paths = excluded.image_paths,
      category_source = 'legacy',
      classification_status = 'legacy',
      updated_at = now();

  IF (
    SELECT count(DISTINCT price_tier)
    FROM public.inv_skus
    WHERE category = 'porcelain_cartoon'
      AND name = '卡通瓷器'
      AND kind = 'single'
      AND is_custom_price = false
  ) <> 31 THEN
    RAISE EXCEPTION '卡通瓷器 must contain exactly 31 price tiers';
  END IF;
END $$;
