ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS inventory_policy text NOT NULL DEFAULT 'tracked';

ALTER TABLE public.inv_skus
  DROP CONSTRAINT IF EXISTS inv_skus_inventory_policy_check;
ALTER TABLE public.inv_skus
  ADD CONSTRAINT inv_skus_inventory_policy_check
  CHECK (inventory_policy IN ('tracked', 'unlimited'));

ALTER TABLE public.youzan_shops
  ADD COLUMN IF NOT EXISTS store_format text NOT NULL DEFAULT 'vintage';

COMMENT ON COLUMN public.inv_skus.inventory_policy IS
  'tracked deducts physical stock; unlimited stays sellable without stock movements';
COMMENT ON COLUMN public.youzan_shops.store_format IS
  'Store concept. New branches default to vintage; future vertical formats use another value.';

UPDATE public.inv_skus
   SET inventory_policy = 'unlimited', updated_at = now()
 WHERE kind = 'single'
   AND is_custom_price = false;

UPDATE public.inv_skus
   SET inventory_policy = 'tracked', updated_at = now()
 WHERE kind <> 'single'
    OR is_custom_price = true;

DO $$
DECLARE
  v_price_tiers numeric[] := ARRAY[
    6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9, 59.9, 69, 79, 89, 99, 129, 159,
    199, 259, 299, 359, 399, 459, 499, 580, 680, 780, 880, 980, 1080, 1180,
    1280, 1380, 1580
  ]::numeric[];
BEGIN
  IF array_length(v_price_tiers, 1) <> 31 THEN
    RAISE EXCEPTION 'Vintage standard catalog must contain exactly 31 price tiers';
  END IF;

  WITH root_categories(category, category_name, category_code) AS (
    VALUES
      ('jp_porcelain', '日本瓷器', 'JP'),
      ('eu_porcelain', '欧洲瓷器', 'EU'),
      ('vintage_toy', '中古玩具', 'TY'),
      ('anime_goods', '二次元周边', 'AN'),
      ('media', '音像制品', 'MD'),
      ('digital', '数码家电', 'DG'),
      ('jewelry', '珠宝首饰', 'JW'),
      ('fashion', '时尚配件', 'FS'),
      ('daily', '日用杂货', 'DL'),
      ('antique', '古美术', 'AT')
  ),
  existing_groups AS (
    SELECT DISTINCT ON (sku.category, sku.name)
      sku.category,
      sku.name,
      sku.sku_code,
      sku.image_url,
      sku.image_paths,
      sku.notes,
      sku.weight_g,
      sku.attributes,
      root.category_code
    FROM public.inv_skus sku
    JOIN root_categories root ON root.category = sku.category
    WHERE sku.kind = 'single'
      AND sku.is_custom_price = false
    ORDER BY sku.category, sku.name, sku.created_at
  ),
  missing_root_groups AS (
    SELECT
      root.category,
      root.category_name AS name,
      'SKU-STD-' || root.category_code AS sku_code,
      NULL::text AS image_url,
      ARRAY[]::text[] AS image_paths,
      NULL::text AS notes,
      NULL::numeric AS weight_g,
      '{}'::jsonb AS attributes,
      root.category_code
    FROM root_categories root
    WHERE NOT EXISTS (
      SELECT 1 FROM existing_groups existing WHERE existing.category = root.category
    )
  ),
  required_groups AS (
    SELECT * FROM existing_groups
    UNION ALL
    SELECT * FROM missing_root_groups
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
    inventory_policy,
    default_shop_ids
  )
  SELECT
    product.category,
    product.name,
    product.sku_code,
    tier.price,
    false,
    'single',
    NULL,
    'STD-' || product.category_code || '-' ||
      lpad((tier.price * 10)::integer::text, 5, '0') || '-' ||
      upper(substr(md5(product.category || '|' || product.name), 1, 8)),
    product.weight_g,
    product.image_url,
    coalesce(product.image_paths, ARRAY[]::text[]),
    0,
    product.notes,
    coalesce(product.attributes, '{}'::jsonb),
    'active',
    'unlimited',
    ARRAY[]::uuid[]
  FROM required_groups product
  CROSS JOIN unnest(v_price_tiers) AS tier(price)
  ON CONFLICT (category, price_tier, name) DO UPDATE
    SET inventory_policy = 'unlimited',
        status = 'active',
        updated_at = now();

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT category, name, count(DISTINCT price_tier) AS tier_count
      FROM public.inv_skus
      WHERE kind = 'single'
        AND is_custom_price = false
      GROUP BY category, name
    ) product
    WHERE product.tier_count <> 31
  ) THEN
    RAISE EXCEPTION 'Every standard product group must contain exactly 31 price tiers';
  END IF;

  IF EXISTS (
    SELECT category
    FROM unnest(ARRAY[
      'jp_porcelain', 'eu_porcelain', 'vintage_toy', 'anime_goods', 'media',
      'digital', 'jewelry', 'fashion', 'daily', 'antique'
    ]::text[]) AS missing(category)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.inv_skus sku
      WHERE sku.category = missing.category
        AND sku.kind = 'single'
        AND sku.is_custom_price = false
    )
  ) THEN
    RAISE EXCEPTION 'Every ERP root category must have a standard product group';
  END IF;

  INSERT INTO public.app_settings(key, value, updated_at)
  VALUES ('inv_price_tiers', to_jsonb(v_price_tiers), now())
  ON CONFLICT (key) DO UPDATE
    SET value = excluded.value,
        updated_at = excluded.updated_at;
END $$;

CREATE OR REPLACE FUNCTION public.inv_apply_movement(
  p_sku_id uuid,
  p_location_id uuid,
  p_delta integer,
  p_ref_type text,
  p_ref_id uuid,
  p_epc text DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new integer;
  v_inventory_policy text;
BEGIN
  SELECT inventory_policy INTO v_inventory_policy
  FROM public.inv_skus
  WHERE id = p_sku_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SKU not found';
  END IF;

  IF v_inventory_policy = 'unlimited' THEN
    RETURN 0;
  END IF;

  INSERT INTO public.inv_stocks (sku_id, location_id, qty, updated_at)
  VALUES (p_sku_id, p_location_id, p_delta, now())
  ON CONFLICT (sku_id, location_id)
  DO UPDATE SET qty = inv_stocks.qty + EXCLUDED.qty, updated_at = now()
  RETURNING qty INTO v_new;

  INSERT INTO public.inv_stock_movements
    (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note, created_by)
  VALUES
    (p_sku_id, p_location_id, p_delta, v_new, p_ref_type, p_ref_id, p_epc, p_note, auth.uid());

  IF EXISTS (SELECT 1 FROM public.inv_locations WHERE id = p_location_id AND kind = 'warehouse') THEN
    UPDATE public.inv_skus SET stock_qty = GREATEST(0, stock_qty + p_delta), updated_at = now()
      WHERE id = p_sku_id;
  END IF;

  RETURN v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.sales_sku_available_qty(
  p_sku_id uuid,
  p_location_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sku public.inv_skus;
  v_component record;
  v_stock integer;
  v_reserved integer;
  v_component_available integer;
  v_available integer;
BEGIN
  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id;
  IF NOT FOUND OR v_sku.status <> 'active' OR NOT v_sku.is_display THEN RETURN 0; END IF;
  IF v_sku.inventory_policy = 'unlimited' THEN RETURN 2147483647; END IF;

  IF v_sku.kind = 'bundle' THEN
    IF jsonb_typeof(v_sku.bundle_items) <> 'array' OR jsonb_array_length(v_sku.bundle_items) = 0 THEN
      RETURN 0;
    END IF;
    v_available := NULL;
    FOR v_component IN
      SELECT component.sku_id, component.qty
      FROM jsonb_to_recordset(v_sku.bundle_items) AS component(sku_id uuid, qty integer)
    LOOP
      SELECT qty INTO v_stock
      FROM public.inv_stocks
      WHERE sku_id = v_component.sku_id AND location_id = p_location_id;
      SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
      FROM public.inventory_reservation_lines line
      JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
      WHERE line.stock_sku_id = v_component.sku_id
        AND line.location_id = p_location_id
        AND reservation.status = 'active'
        AND reservation.expires_at > now();
      v_component_available :=
        greatest(0, coalesce(v_stock, 0) - v_reserved) / greatest(v_component.qty, 1);
      v_available := CASE
        WHEN v_available IS NULL THEN v_component_available
        ELSE least(v_available, v_component_available)
      END;
    END LOOP;
    RETURN coalesce(v_available, 0);
  END IF;

  SELECT qty INTO v_stock
  FROM public.inv_stocks
  WHERE sku_id = p_sku_id AND location_id = p_location_id;
  SELECT coalesce(sum(line.quantity), 0) INTO v_reserved
  FROM public.inventory_reservation_lines line
  JOIN public.inventory_reservations reservation ON reservation.id = line.reservation_id
  WHERE line.stock_sku_id = p_sku_id
    AND line.location_id = p_location_id
    AND reservation.status = 'active'
    AND reservation.expires_at > now();
  v_available := greatest(0, coalesce(v_stock, 0) - v_reserved);
  IF v_sku.is_custom_price THEN v_available := least(v_available, 1); END IF;
  RETURN v_available;
END;
$$;

REVOKE ALL ON FUNCTION public.inv_apply_movement(uuid,uuid,integer,text,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sales_sku_available_qty(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inv_apply_movement(uuid,uuid,integer,text,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_sku_available_qty(uuid,uuid) TO service_role;