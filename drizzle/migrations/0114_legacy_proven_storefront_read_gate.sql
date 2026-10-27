-- Read-only compatibility for records predating the first readiness rollout; no state backfill.
CREATE OR REPLACE FUNCTION public.storefront_legacy_image_ready(p_sku uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT coalesce((SELECT s.created_at < timestamptz '2026-10-22 10:54:05.063706+00' AND s.status='active' AND btrim(s.name)<>''
AND NOT EXISTS(SELECT 1 FROM listing_readiness r WHERE r.sku_id=s.id)
AND EXISTS(SELECT 1 FROM inv_categories k WHERE k.code=s.category AND k.is_active AND k.name ~ '[一-龥]')
AND cardinality(s.image_paths)>0
AND NOT EXISTS(SELECT 1 FROM unnest(s.image_paths) p WHERE NOT listing_image_has_success_receipt(s.id,p))
AND EXISTS(SELECT 1 FROM inv_product_content c WHERE c.sku_id=s.id AND c.published_version IS NOT NULL AND c.published_version>0 AND c.published_version<=c.version AND jsonb_typeof(c.published_blocks)='array' AND jsonb_array_length(c.published_blocks)>0
AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.published_blocks) b WHERE b->>'type'='image' AND (b->>'storage_path' IS NULL OR b->>'storage_path' NOT LIKE 'sku-listing/%'
OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sku-listing' AND o.name=substring(b->>'storage_path' FROM 13))
OR NOT (EXISTS(SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id=s.id AND j.block_id=b->>'id' AND j.status='succeeded' AND j.target_path=b->>'storage_path')
OR (b->>'storage_path'=ANY(s.image_paths) AND listing_image_has_success_receipt(s.id,b->>'storage_path'))))))
FROM inv_skus s WHERE s.id=p_sku),false)
$$;
CREATE OR REPLACE FUNCTION public.storefront_image_ready(p_sku uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT coalesce((SELECT CASE WHEN s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited' THEN
CASE WHEN EXISTS(SELECT 1 FROM listing_readiness r WHERE r.sku_id=s.id) THEN listing_readiness_is_ready(s.id) ELSE storefront_legacy_image_ready(s.id) END
ELSE true END FROM inv_skus s WHERE s.id=p_sku),false)
$$;
REVOKE ALL ON FUNCTION public.storefront_legacy_image_ready(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.storefront_legacy_image_ready(uuid) TO service_role;