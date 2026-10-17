-- 0078 图片状态只认“明确确认”：已排队任务全部完成，或建品时明确不做 AI 修图后才使用原图；未确认一直 pending（无超时）。
CREATE OR REPLACE FUNCTION public.listing_readiness_refresh(p_sku uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; s inv_skus; v_open int; v_failed int; v_err text; v_detail text;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  SELECT * INTO s FROM inv_skus WHERE id = p_sku;
  r.last_error := NULL;
  IF COALESCE(btrim(s.name),'') <> '' AND COALESCE(btrim(s.category),'') <> '' THEN
    r.recognition_status := 'succeeded';
  ELSE r.recognition_status := 'failed'; r.last_error := 'missing_category';
  END IF;
  SELECT count(*) FILTER (WHERE status IN ('queued','processing','retryable_failed')),
         count(*) FILTER (WHERE status = 'permanent_failed'),
         max(last_error) FILTER (WHERE status = 'permanent_failed')
    INTO v_open, v_failed, v_err
    FROM inv_listing_image_jobs WHERE sku_id = p_sku AND readiness_revision >= r.image_input_revision;
  IF v_open > 0 THEN r.image_status := 'running';
  ELSIF v_failed > 0 THEN r.image_status := 'failed'; r.last_error := COALESCE(r.last_error, 'image_failed');
  ELSIF NOT r.images_settled THEN r.image_status := 'pending';
  ELSIF COALESCE(array_length(s.image_paths,1),0) > 0 OR s.image_url IS NOT NULL THEN r.image_status := 'succeeded';
  ELSE r.image_status := 'failed'; r.last_error := COALESCE(r.last_error, 'missing_images');
  END IF;
  v_detail := listing_readiness_detail_images_state(p_sku);
  IF v_detail = 'failed' THEN r.last_error := COALESCE(r.last_error, 'detail_image_failed'); END IF;
  UPDATE listing_readiness SET recognition_status = r.recognition_status, recognition_revision = r.input_revision,
    image_status = r.image_status, image_revision = r.input_revision, last_error = r.last_error, updated_at = now()
   WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status','ok','input_revision',r.input_revision,'recognition',r.recognition_status,
    'image',r.image_status,'detail_images',v_detail,'content',r.content_status,'content_revision',r.content_revision,
    'released',listing_readiness_release(p_sku));
END $$;