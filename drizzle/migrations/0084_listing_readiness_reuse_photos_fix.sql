CREATE OR REPLACE FUNCTION public.listing_readiness_append_reuse_photos(p_sku uuid, p_paths text[], p_image_url text,
  p_plan text, p_actor uuid, p_policy text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cur text[]; v_new text[]; v_rev integer; v_n integer := 0; v_raw boolean;
BEGIN
  IF p_plan IN ('ai','pending_consent') AND (p_actor IS NULL OR COALESCE(p_policy,'') = '') THEN
    RAISE EXCEPTION 'image_plan_actor_required' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(image_paths, '{}') INTO v_cur FROM inv_skus WHERE id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT COALESCE(array_agg(p ORDER BY o), '{}') INTO v_new FROM (
    SELECT p, min(o) o FROM unnest(COALESCE(p_paths, '{}')) WITH ORDINALITY t(p, o)
     WHERE COALESCE(p, '') <> '' AND NOT (p = ANY(v_cur))
       AND NOT (p LIKE 'sku-raw/%' AND EXISTS (SELECT 1 FROM inv_listing_image_jobs j WHERE j.sku_id = p_sku
                  AND j.source_bucket = 'sku-raw' AND j.source_path = substring(p FROM length('sku-raw/') + 1)))
     GROUP BY p) x;
  IF COALESCE(array_length(v_new, 1), 0) = 0 THEN RETURN 0; END IF;
  v_raw := listing_readiness_has_raw(v_new);
  IF v_raw THEN
    INSERT INTO listing_readiness (sku_id, images_settled) VALUES (p_sku, false) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM set_config('boomer.listing_image_apply', '1', true);
  UPDATE inv_skus SET image_paths = v_cur || v_new,
    image_url = COALESCE(image_url, p_image_url), updated_at = now() WHERE id = p_sku;
  PERFORM set_config('boomer.listing_image_apply', '', true);
  UPDATE listing_readiness SET input_revision = input_revision + 1, image_input_revision = input_revision + 1,
    recognition_status = 'pending', image_status = 'pending', content_status = 'pending', last_error = NULL,
    images_settled = CASE WHEN v_raw THEN p_plan <> 'pending_consent' ELSE images_settled END,
    image_plan = CASE WHEN v_raw THEN p_plan ELSE image_plan END,
    image_ai_actor = CASE WHEN v_raw THEN p_actor ELSE image_ai_actor END,
    image_ai_policy = CASE WHEN NOT v_raw THEN image_ai_policy WHEN p_plan = 'raw_declined' THEN NULL ELSE p_policy END,
    image_plan_at = CASE WHEN v_raw THEN now() ELSE image_plan_at END, updated_at = now()
   WHERE sku_id = p_sku RETURNING input_revision INTO v_rev;
  IF v_raw AND p_plan = 'ai' THEN
    INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, source_index, ai_actor_user_id,
      ai_policy_version, target_bucket, status, next_run_at, readiness_revision)
    SELECT p_sku, 'sku-raw', substring(p FROM length('sku-raw/') + 1), (array_position(v_cur || v_new, p) - 1)::int,
           p_actor, p_policy, 'sku-listing', 'queued', now(), v_rev
      FROM unnest(v_new) p WHERE p LIKE 'sku-raw/%'
    ON CONFLICT (sku_id, source_bucket, source_path) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      UPDATE inv_skus SET image_processing_status = 'queued', image_processing_updated_at = now() WHERE id = p_sku;
    END IF;
  END IF;
  RETURN COALESCE(array_length(v_new, 1), 0);
END $$;

CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit_v2(p_device_id uuid, p_user_id uuid, p_client_op_id text,
  p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text,
  p_release_shop_id uuid, p_image_plan text, p_ai_policy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;

REVOKE ALL ON FUNCTION public.listing_readiness_append_reuse_photos(uuid, text[], text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_smart_create_commit_v2(uuid, uuid, text, text, uuid, boolean, jsonb, text[], text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_smart_create_commit_v2(uuid, uuid, text, text, uuid, boolean, jsonb, text[], text, uuid, text, text) TO service_role;