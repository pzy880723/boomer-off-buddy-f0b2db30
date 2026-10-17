-- 0082 明确 AI 计划且 image_paths 仍含原图时 refresh 绝不成功；缺任务的原图按持久化 actor 幂等补入队。raw_declined 与旧 NULL 手动 settled 不变。
CREATE OR REPLACE FUNCTION public.listing_readiness_refresh(p_sku uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; s inv_skus; v_open int; v_failed int; v_total int; v_err text; v_detail text;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  SELECT * INTO s FROM inv_skus WHERE id = p_sku;
  r.last_error := NULL;
  IF COALESCE(btrim(s.name),'') <> '' AND COALESCE(btrim(s.category),'') <> '' THEN
    r.recognition_status := 'succeeded';
  ELSE r.recognition_status := 'failed'; r.last_error := 'missing_category';
  END IF;
  IF r.image_plan = 'ai' AND r.image_ai_actor IS NOT NULL AND COALESCE(r.image_ai_policy,'') <> '' THEN
    INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, source_index, ai_actor_user_id,
      ai_policy_version, target_bucket, status, next_run_at, readiness_revision)
    SELECT p_sku, 'sku-raw', substring(p FROM length('sku-raw/') + 1), (o - 1)::int, r.image_ai_actor, r.image_ai_policy,
           'sku-listing', 'queued', now(), r.input_revision
      FROM unnest(s.image_paths) WITH ORDINALITY t(p, o) WHERE p LIKE 'sku-raw/%'
    ON CONFLICT (sku_id, source_bucket, source_path) DO NOTHING;
  END IF;
  SELECT count(*) FILTER (WHERE status IN ('queued','processing','retryable_failed')),
         count(*) FILTER (WHERE status = 'permanent_failed'),
         count(*),
         max(last_error) FILTER (WHERE status = 'permanent_failed')
    INTO v_open, v_failed, v_total, v_err
    FROM inv_listing_image_jobs WHERE sku_id = p_sku AND readiness_revision >= r.image_input_revision;
  IF v_total > 0 THEN r.images_settled := true; END IF;
  IF v_open > 0 THEN r.image_status := 'running';
  ELSIF v_failed > 0 THEN r.image_status := 'failed'; r.last_error := COALESCE(r.last_error, 'image_failed');
  ELSIF NOT r.images_settled THEN r.image_status := 'pending';
  ELSIF r.image_plan = 'ai' AND listing_readiness_has_raw(s.image_paths) THEN
    r.image_status := 'failed'; r.last_error := COALESCE(r.last_error, 'raw_unprocessed');
  ELSIF COALESCE(array_length(s.image_paths,1),0) > 0 OR s.image_url IS NOT NULL THEN r.image_status := 'succeeded';
  ELSE r.image_status := 'failed'; r.last_error := COALESCE(r.last_error, 'missing_images');
  END IF;
  v_detail := listing_readiness_detail_images_state(p_sku);
  IF v_detail = 'failed' THEN r.last_error := COALESCE(r.last_error, 'detail_image_failed'); END IF;
  UPDATE listing_readiness SET recognition_status = r.recognition_status, recognition_revision = r.input_revision,
    image_status = r.image_status, image_revision = r.input_revision, images_settled = r.images_settled,
    last_error = r.last_error, updated_at = now()
   WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status','ok','input_revision',r.input_revision,'recognition',r.recognition_status,
    'image',r.image_status,'image_plan',r.image_plan,'detail_images',v_detail,'content',r.content_status,
    'content_revision',r.content_revision,'released',listing_readiness_release(p_sku));
END $$;
REVOKE ALL ON FUNCTION public.listing_readiness_refresh(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_readiness_refresh(uuid) TO service_role;