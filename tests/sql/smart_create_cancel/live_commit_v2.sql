CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit_v2(p_device_id uuid, p_user_id uuid, p_client_op_id text, p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid, p_image_plan text, p_ai_policy text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb; v_sku uuid; v_plan text; v_queued integer; v_existing uuid; v_added integer := 0;
BEGIN
  IF p_image_plan IS NULL OR p_image_plan NOT IN ('ai','raw_declined','pending_consent') THEN
    RAISE EXCEPTION 'invalid_image_plan' USING ERRCODE = '22023';
  END IF;
  IF p_reuse THEN
    SELECT id INTO v_existing FROM inv_skus
     WHERE category = p_sku->>'category' AND price_tier = (p_sku->>'price_tier')::numeric AND name = p_sku->>'name'
     ORDER BY created_at LIMIT 1;
  END IF;
  v := public.handheld_smart_create_commit(p_device_id, p_user_id, p_client_op_id, p_fingerprint, p_location_id,
    p_reuse, p_sku, p_epcs, p_note, p_release_shop_id);
  v_sku := NULLIF(v->>'sku_id','')::uuid;
  IF v_sku IS NULL THEN RETURN v; END IF;
  IF NOT COALESCE((v->>'replayed')::boolean, false) THEN
    IF v_existing IS NOT NULL AND v_sku = v_existing THEN
      v_added := listing_readiness_append_reuse_photos(v_sku,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_sku->'image_paths','[]'::jsonb))),
        p_sku->>'image_url', p_image_plan, p_user_id, p_ai_policy);
    ELSIF EXISTS (SELECT 1 FROM listing_readiness WHERE sku_id = v_sku AND image_plan IS NULL) THEN
      PERFORM listing_readiness_apply_image_plan(v_sku, p_image_plan, p_user_id, p_ai_policy);
    END IF;
  END IF;
  SELECT image_plan INTO v_plan FROM listing_readiness WHERE sku_id = v_sku;
  SELECT count(*) INTO v_queued FROM inv_listing_image_jobs
   WHERE sku_id = v_sku AND status IN ('queued','processing','retryable_failed');
  RETURN v || jsonb_build_object('image_plan', v_plan, 'image_jobs_open', v_queued, 'reused', v_existing IS NOT NULL AND v_sku = v_existing,
    'photos_appended', v_added);
END $function$

;
