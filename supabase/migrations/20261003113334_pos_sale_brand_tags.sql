-- Optional per-sale brand metadata; SKU identity, stock and prices are unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.commerce_order_items
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.inv_brands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS brand_name_snapshot text;
ALTER TABLE public.pos_held_cart_items
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.inv_brands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS brand_name_snapshot text;
DROP INDEX IF EXISTS public.pos_held_cart_items_line_key;
CREATE UNIQUE INDEX pos_held_cart_items_line_key ON public.pos_held_cart_items
  (held_cart_id, sku_id, coalesce(subcategory_code, ''), coalesce(brand_id::text, ''));

-- Patch only the verified production bodies. A concurrent function change aborts the transaction.
DO $migration$
DECLARE definition text; body_hash text;
BEGIN
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO definition, body_hash FROM pg_proc
    WHERE oid = 'public.pos_complete_sale(uuid,uuid,text,jsonb,jsonb,uuid,text)'::regprocedure;
  IF position('v_brand_name text;' in definition) = 0 THEN
    IF body_hash <> '84dd6e195341d8d1128f4e3f410ceac0' THEN RAISE EXCEPTION 'pos_brand_sale_baseline_drift'; END IF;
    definition := replace(definition, $old$  v_subcategory_name text;$old$, $new$  v_subcategory_name text;
  v_brand_name text;$new$);
    definition := replace(definition, $old$           ord
$old$, $new$           nullif(elem->>'brand_id', '')::uuid AS brand_id,
           ord
$new$);
    definition := replace(definition, $old$    INSERT INTO public.commerce_order_items ($old$, $new$    v_brand_name := NULL;
    IF v_item.brand_id IS NOT NULL THEN
      SELECT name INTO v_brand_name FROM public.inv_brands
       WHERE id = v_item.brand_id AND status = 'active'
         AND (entity_type IN ('brand', 'kiln') OR id IN (
           '66222295-6e7b-4336-8055-3a7ef23c8d7d'::uuid,
           '74c76f9f-817b-4f5c-b02d-20acc5e8c10c'::uuid));
      IF v_brand_name IS NULL THEN RAISE EXCEPTION 'invalid_brand'; END IF;
    END IF;

    INSERT INTO public.commerce_order_items ($new$);
    definition := replace(definition, $old$      category_code, category_name_snapshot, subcategory_code, subcategory_name_snapshot
$old$, $new$      category_code, category_name_snapshot, subcategory_code, subcategory_name_snapshot,
      brand_id, brand_name_snapshot
$new$);
    definition := replace(definition, $old$      v_item.subcategory_code, v_subcategory_name
$old$, $new$      v_item.subcategory_code, v_subcategory_name,
      v_item.brand_id, v_brand_name
$new$);
    definition := replace(definition, $old$           'subcategory_name', item.subcategory_name_snapshot
$old$, $new$           'subcategory_name', item.subcategory_name_snapshot,
           'brand_id', item.brand_id, 'brand_name', item.brand_name_snapshot
$new$);
    EXECUTE definition;
  END IF;
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO definition, body_hash FROM pg_proc
    WHERE oid = 'public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer)'::regprocedure;
  IF position('brand_name_snapshot' in definition) = 0 THEN
    IF body_hash <> '6d1f0aba782287a10e2692364f96437c' THEN RAISE EXCEPTION 'pos_brand_points_baseline_drift'; END IF;
    definition := replace(definition,
      $old$'subcategory_code',subcategory_code,'subcategory_name',subcategory_name_snapshot)$old$,
      $new$'subcategory_code',subcategory_code,'subcategory_name',subcategory_name_snapshot,
      'brand_id',brand_id,'brand_name',brand_name_snapshot)$new$);
    EXECUTE definition;
  END IF;
END;
$migration$;
NOTIFY pgrst, 'reload schema';
COMMIT;
