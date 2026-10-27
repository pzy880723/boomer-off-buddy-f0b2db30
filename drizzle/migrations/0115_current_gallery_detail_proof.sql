-- Positive detail proof shared by strict current readiness and proven legacy reads.
-- No job creation, state backfill, revision downgrade, or external calls.
CREATE OR REPLACE FUNCTION public.listing_detail_image_has_success_receipt(p_sku uuid,p_block text,p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT coalesce(p_path LIKE 'sku-listing/%'
AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sku-listing' AND o.name=substring(p_path FROM 13))
AND (EXISTS(SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id=p_sku AND j.block_id=p_block AND j.status='succeeded' AND j.target_path=p_path)
OR EXISTS(SELECT 1 FROM inv_skus s WHERE s.id=p_sku AND p_path=ANY(s.image_paths) AND public.listing_image_has_success_receipt(s.id,p_path))),false)
$$;
REVOKE ALL ON FUNCTION public.listing_detail_image_has_success_receipt(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.listing_detail_image_has_success_receipt(uuid,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.listing_readiness_detail_images_state(p_sku uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT CASE WHEN EXISTS(SELECT 1 FROM inv_skus s WHERE s.id=p_sku AND s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited') THEN
 CASE WHEN EXISTS(SELECT 1 FROM inv_product_content c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.published_blocks)='array' THEN c.published_blocks ELSE '[]'::jsonb END) b
 WHERE c.sku_id=p_sku AND b->>'type'='image' AND NOT public.listing_detail_image_has_success_receipt(p_sku,b->>'id',b->>'storage_path')
 AND NOT EXISTS(SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id=p_sku AND j.block_id=b->>'id' AND (j.source_path=b->>'storage_path' OR j.target_path=b->>'storage_path') AND j.status IN('queued','processing','retryable_failed'))) THEN 'failed'
 WHEN EXISTS(SELECT 1 FROM inv_product_content c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.published_blocks)='array' THEN c.published_blocks ELSE '[]'::jsonb END) b
 WHERE c.sku_id=p_sku AND b->>'type'='image' AND NOT public.listing_detail_image_has_success_receipt(p_sku,b->>'id',b->>'storage_path')) THEN 'running'
 ELSE 'succeeded' END
 ELSE CASE
 WHEN EXISTS(SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id=p_sku AND j.status IN('queued','processing','retryable_failed')) THEN 'running'
 WHEN EXISTS(SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id=p_sku AND j.status='permanent_failed') THEN 'failed'
 ELSE 'succeeded' END END
$$;
CREATE OR REPLACE FUNCTION public.listing_readiness_is_ready(p_sku uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT CASE WHEN s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited' THEN coalesce((SELECT r.images_settled AND r.image_plan IS DISTINCT FROM 'raw_declined' AND r.recognition_status='succeeded' AND r.recognition_revision=r.input_revision AND r.image_status='succeeded' AND r.image_revision=r.input_revision AND r.content_status='succeeded' AND r.content_revision=r.input_revision AND cardinality(s.image_paths)>0 AND NOT public.listing_readiness_has_raw(s.image_paths)
AND NOT EXISTS(SELECT 1 FROM unnest(s.image_paths) p WHERE NOT public.listing_image_has_success_receipt(p_sku,p))
AND NOT EXISTS(SELECT 1 FROM inv_listing_image_jobs j WHERE j.sku_id=p_sku AND j.readiness_revision>=r.image_input_revision AND j.status<>'succeeded' AND j.source_bucket||'/'||j.source_path=ANY(s.image_paths))
AND listing_readiness_detail_images_state(p_sku)='succeeded'
AND EXISTS(SELECT 1 FROM inv_product_content c WHERE c.sku_id=p_sku AND c.published_version IS NOT NULL AND jsonb_typeof(c.published_blocks)='array' AND jsonb_array_length(c.published_blocks)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.published_blocks) b WHERE b->>'type'='image' AND (NOT public.listing_detail_image_has_success_receipt(p_sku,b->>'id',b->>'storage_path')))) FROM listing_readiness r WHERE r.sku_id=p_sku),false)
ELSE coalesce((SELECT r.images_settled AND r.recognition_status='succeeded' AND r.recognition_revision=r.input_revision AND r.image_status='succeeded' AND r.image_revision=r.input_revision AND r.content_status='succeeded' AND r.content_revision=r.input_revision AND listing_readiness_detail_images_state(p_sku)='succeeded' AND EXISTS(SELECT 1 FROM inv_product_content c WHERE c.sku_id=p_sku AND jsonb_typeof(c.published_blocks)='array' AND jsonb_array_length(c.published_blocks)>0) FROM listing_readiness r WHERE r.sku_id=p_sku),true) END FROM inv_skus s WHERE s.id=p_sku
$$;
CREATE OR REPLACE FUNCTION public.storefront_legacy_image_ready(p_sku uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT coalesce((SELECT s.created_at < timestamptz '2026-10-22 10:54:05.063706+00' AND s.status='active' AND btrim(s.name)<>''
AND NOT EXISTS(SELECT 1 FROM listing_readiness r WHERE r.sku_id=s.id)
AND EXISTS(SELECT 1 FROM inv_categories k WHERE k.code=s.category AND k.is_active AND k.name ~ '[一-龥]')
AND cardinality(s.image_paths)>0
AND NOT EXISTS(SELECT 1 FROM unnest(s.image_paths) p WHERE NOT listing_image_has_success_receipt(s.id,p))
AND EXISTS(SELECT 1 FROM inv_product_content c WHERE c.sku_id=s.id AND c.published_version IS NOT NULL AND c.published_version>0 AND c.published_version<=c.version AND jsonb_typeof(c.published_blocks)='array' AND jsonb_array_length(c.published_blocks)>0
AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.published_blocks) b WHERE b->>'type'='image' AND (NOT public.listing_detail_image_has_success_receipt(s.id,b->>'id',b->>'storage_path'))))
FROM inv_skus s WHERE s.id=p_sku),false)
$$;