-- Handheld photo listing is a one-off custom SKU. Keep its stock movement and
-- BOOMER marketplace publication in the same database transaction.

ALTER TABLE public.inv_skus
  DROP CONSTRAINT IF EXISTS inv_skus_category_price_tier_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_skus_standard_identity
  ON public.inv_skus(category, price_tier, name)
  WHERE is_custom_price = false;

ALTER TABLE public.commerce_listings
  ADD COLUMN IF NOT EXISTS image_paths jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.sync_handheld_custom_listing(
  p_sku_id uuid,
  p_location_id uuid,
  p_ref_type text,
  p_delta integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sku public.inv_skus;
  v_location public.inv_locations;
  v_stable_cover text;
  v_stable_images jsonb := '[]'::jsonb;
BEGIN
  IF p_ref_type <> 'handheld_smart_create' OR p_delta <= 0 THEN
    RETURN;
  END IF;

  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO v_location FROM public.inv_locations WHERE id = p_location_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_location.kind <> 'shop'
     OR v_sku.kind <> 'single'
     OR NOT v_sku.is_custom_price
     OR v_sku.status <> 'active'
     OR NOT v_sku.is_display THEN
    RETURN;
  END IF;

  IF v_sku.image_url ~ '^https?://'
     AND position('token=' IN v_sku.image_url) = 0 THEN
    v_stable_cover := v_sku.image_url;
    v_stable_images := jsonb_build_array(v_sku.image_url);
  END IF;

  INSERT INTO public.commerce_listings (
    sku_id,
    location_id,
    title,
    description,
    cover_url,
    image_urls,
    image_paths,
    price,
    condition_grade,
    category,
    status,
    product_type,
    published_at,
    created_by,
    updated_at
  ) VALUES (
    v_sku.id,
    v_location.id,
    v_sku.name,
    v_sku.notes,
    v_stable_cover,
    v_stable_images,
    to_jsonb(coalesce(v_sku.image_paths, ARRAY[]::text[])),
    v_sku.price_tier,
    v_sku.grade,
    v_sku.category,
    'published',
    'custom',
    now(),
    auth.uid(),
    now()
  )
  ON CONFLICT (sku_id, location_id) DO UPDATE
    SET title = excluded.title,
        description = excluded.description,
        cover_url = excluded.cover_url,
        image_urls = excluded.image_urls,
        image_paths = excluded.image_paths,
        price = excluded.price,
        condition_grade = excluded.condition_grade,
        category = excluded.category,
        product_type = 'custom',
        status = CASE
          WHEN commerce_listings.status IN ('hidden', 'archived', 'sold')
            THEN commerce_listings.status
          ELSE 'published'
        END,
        published_at = coalesce(commerce_listings.published_at, now()),
        updated_at = now();
END;
$$;

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

  PERFORM public.sync_handheld_custom_listing(
    p_sku_id,
    p_location_id,
    p_ref_type,
    p_delta
  );

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_handheld_custom_listing(uuid,uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inv_apply_movement(uuid,uuid,integer,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_handheld_custom_listing(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_apply_movement(uuid,uuid,integer,text,uuid,text,text) TO service_role;
