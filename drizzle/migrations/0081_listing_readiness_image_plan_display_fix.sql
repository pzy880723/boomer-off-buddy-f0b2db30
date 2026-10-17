-- 0081 图片计划持久化 + 已上架展示隔离（增量纠错，不改 0075/0077/0078；0080 为误提交的空占位，无结构变化）。
-- 1) 图片计划与可信 actor/policy 在建品原事务内持久化；AI 任务（既有 inv_listing_image_jobs 队列）同事务入队。
-- 2) 编辑原图时：未确认且无 actor 绝不隐式视为已确认；只有 ai(+actor) 入队或明确 raw_declined 才算已定。
-- 3) 未确认授权(pending_consent)由既有图片 worker 的 sweep 幂等补决；不伪造默认授权。
-- 4) 已发布 listing 在重新处理期间保留旧的完整展示；新图暂存 pending_display，就绪后原子替换。

ALTER TABLE public.listing_readiness ADD COLUMN IF NOT EXISTS image_plan text;
ALTER TABLE public.listing_readiness ADD COLUMN IF NOT EXISTS image_ai_actor uuid;
ALTER TABLE public.listing_readiness ADD COLUMN IF NOT EXISTS image_ai_policy text;
ALTER TABLE public.listing_readiness ADD COLUMN IF NOT EXISTS image_plan_at timestamptz;
DO $$ BEGIN
  ALTER TABLE public.listing_readiness ADD CONSTRAINT listing_readiness_image_plan_chk
    CHECK (image_plan IS NULL OR image_plan IN ('ai','raw_declined','pending_consent'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.listing_readiness.image_plan IS 'ai=已授权并入队；raw_declined=明确不做AI修图（才可用原图）；pending_consent=授权未明确，等待 worker 补决；NULL=旧记录，未确认';
COMMENT ON COLUMN public.listing_readiness.image_ai_actor IS '建品时服务端验证的员工（AI 授权主体）；worker 每次 AI 调用前仍复核授权';

ALTER TABLE public.commerce_listings ADD COLUMN IF NOT EXISTS pending_display jsonb;
COMMENT ON COLUMN public.commerce_listings.pending_display IS '已发布商品重新处理期间暂存的新图片字段 {image_paths,cover_url,image_urls}；公开读取仍用旧的完整展示，准备就绪后原子替换并清空';

CREATE OR REPLACE FUNCTION public.listing_readiness_apply_image_plan(p_sku uuid, p_plan text, p_actor uuid, p_policy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; v_paths text[]; v_n integer := 0; v_settled boolean;
BEGIN
  IF p_plan IS NULL OR p_plan NOT IN ('ai','raw_declined','pending_consent') THEN
    RAISE EXCEPTION 'invalid_image_plan' USING ERRCODE = '22023';
  END IF;
  IF p_plan IN ('ai','pending_consent') AND (p_actor IS NULL OR COALESCE(p_policy,'') = '') THEN
    RAISE EXCEPTION 'image_plan_actor_required' USING ERRCODE = '22023';
  END IF;
  SELECT image_paths INTO v_paths FROM inv_skus WHERE id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','missing'); END IF;
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  v_settled := NOT listing_readiness_has_raw(v_paths);
  IF p_plan = 'ai' THEN
    INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, source_index, ai_actor_user_id,
      ai_policy_version, target_bucket, status, next_run_at, readiness_revision)
    SELECT p_sku, 'sku-raw', substring(p FROM length('sku-raw/') + 1), (o - 1)::int, p_actor, p_policy,
           'sku-listing', 'queued', now(), r.input_revision
      FROM unnest(v_paths) WITH ORDINALITY t(p, o) WHERE p LIKE 'sku-raw/%'
    ON CONFLICT (sku_id, source_bucket, source_path) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_settled := true;
    IF v_n > 0 THEN
      UPDATE inv_skus SET image_processing_status = 'queued', image_processing_updated_at = now() WHERE id = p_sku;
    END IF;
  ELSIF p_plan = 'raw_declined' THEN
    v_settled := true;
  END IF;
  UPDATE listing_readiness SET image_plan = p_plan, image_ai_actor = p_actor,
    image_ai_policy = CASE WHEN p_plan = 'raw_declined' THEN NULL ELSE p_policy END,
    image_plan_at = now(), images_settled = images_settled OR v_settled, updated_at = now()
   WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status','ok','plan',p_plan,'queued',v_n,'images_settled',r.images_settled OR v_settled);
END $$;

CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit_v2(p_device_id uuid, p_user_id uuid, p_client_op_id text,
  p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text,
  p_release_shop_id uuid, p_image_plan text, p_ai_policy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_sku uuid; v_plan text; v_queued integer;
BEGIN
  IF p_image_plan IS NULL OR p_image_plan NOT IN ('ai','raw_declined','pending_consent') THEN
    RAISE EXCEPTION 'invalid_image_plan' USING ERRCODE = '22023';
  END IF;
  v := public.handheld_smart_create_commit(p_device_id, p_user_id, p_client_op_id, p_fingerprint, p_location_id,
    p_reuse, p_sku, p_epcs, p_note, p_release_shop_id);
  v_sku := NULLIF(v->>'sku_id','')::uuid;
  IF v_sku IS NULL THEN RETURN v; END IF;
  IF NOT COALESCE((v->>'replayed')::boolean, false)
     AND EXISTS (SELECT 1 FROM listing_readiness WHERE sku_id = v_sku AND image_plan IS NULL) THEN
    PERFORM listing_readiness_apply_image_plan(v_sku, p_image_plan, p_user_id, p_ai_policy);
  END IF;
  SELECT image_plan INTO v_plan FROM listing_readiness WHERE sku_id = v_sku;
  SELECT count(*) INTO v_queued FROM inv_listing_image_jobs
   WHERE sku_id = v_sku AND status IN ('queued','processing','retryable_failed');
  RETURN v || jsonb_build_object('image_plan', v_plan, 'image_jobs_open', v_queued);
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_pending_consent(p_limit integer DEFAULT 20)
RETURNS TABLE(sku_id uuid, actor uuid, policy text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.sku_id, r.image_ai_actor, r.image_ai_policy FROM listing_readiness r
   WHERE r.image_plan = 'pending_consent' AND r.image_ai_actor IS NOT NULL
   ORDER BY r.image_plan_at NULLS FIRST, r.sku_id LIMIT GREATEST(1, LEAST(COALESCE(p_limit,20), 100));
$$;

CREATE OR REPLACE FUNCTION public.listing_readiness_resolve_consent(p_sku uuid, p_actor uuid, p_decision text, p_policy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness;
BEGIN
  IF p_decision NOT IN ('ai','raw_declined') THEN RAISE EXCEPTION 'invalid_decision' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM inv_skus WHERE id = p_sku FOR UPDATE;
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND OR r.image_plan IS DISTINCT FROM 'pending_consent' OR r.image_ai_actor IS DISTINCT FROM p_actor THEN
    RETURN jsonb_build_object('status','noop');
  END IF;
  RETURN listing_readiness_apply_image_plan(p_sku, p_decision, p_actor, p_policy);
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_bump(p_sku uuid, p_images boolean, p_paths text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; v_rev integer; v_actor uuid; v_policy text; v_plan text; v_settled boolean;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_rev := r.input_revision + 1;
  v_settled := r.images_settled;
  IF p_images THEN
    v_settled := NOT listing_readiness_has_raw(p_paths);
    IF NOT v_settled THEN
      v_plan := r.image_plan; v_actor := r.image_ai_actor; v_policy := r.image_ai_policy;
      IF v_plan IS NULL THEN
        SELECT ai_actor_user_id, ai_policy_version INTO v_actor, v_policy FROM inv_listing_image_jobs
         WHERE sku_id = p_sku AND ai_actor_user_id IS NOT NULL ORDER BY created_at DESC LIMIT 1;
        IF v_actor IS NOT NULL THEN v_plan := 'ai'; END IF;
      END IF;
      IF v_plan = 'ai' AND v_actor IS NOT NULL AND COALESCE(v_policy,'') <> '' THEN
        INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, source_index, ai_actor_user_id,
          ai_policy_version, target_bucket, status, next_run_at, readiness_revision)
        SELECT p_sku, 'sku-raw', substring(p FROM length('sku-raw/') + 1), (o - 1)::int, v_actor, v_policy,
               'sku-listing', 'queued', now(), v_rev
          FROM unnest(p_paths) WITH ORDINALITY t(p, o) WHERE p LIKE 'sku-raw/%'
        ON CONFLICT (sku_id, source_bucket, source_path) DO UPDATE SET status = 'queued', attempts = 0,
          readiness_revision = EXCLUDED.readiness_revision, next_run_at = now(), last_error = NULL, claim_token = NULL,
          lease_until = NULL, locked_at = NULL, locked_by = NULL, completed_at = NULL, updated_at = now();
        v_settled := true;
      ELSIF v_plan = 'raw_declined' THEN
        v_settled := true;
      ELSE
        v_settled := false;
      END IF;
    END IF;
  END IF;
  UPDATE listing_readiness SET input_revision = v_rev,
    image_input_revision = CASE WHEN p_images THEN v_rev ELSE image_input_revision END,
    images_settled = v_settled, recognition_status = 'pending', image_status = 'pending',
    content_status = 'pending', last_error = NULL, updated_at = now()
   WHERE sku_id = p_sku;
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_on_sku_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_img boolean;
BEGIN
  v_img := NEW.image_paths IS DISTINCT FROM OLD.image_paths
    AND COALESCE(current_setting('boomer.listing_image_apply', true), '') <> '1';
  IF v_img AND listing_readiness_has_raw(NEW.image_paths)
     AND NOT EXISTS (SELECT 1 FROM listing_readiness WHERE sku_id = NEW.id)
     AND EXISTS (SELECT 1 FROM commerce_listings l WHERE l.sku_id = NEW.id AND l.status = 'published') THEN
    INSERT INTO listing_readiness (sku_id, images_settled) VALUES (NEW.id, false) ON CONFLICT DO NOTHING;
  END IF;
  IF v_img OR NEW.name IS DISTINCT FROM OLD.name OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.grade IS DISTINCT FROM OLD.grade
     OR NEW.ip_id IS DISTINCT FROM OLD.ip_id THEN
    PERFORM listing_readiness_bump(NEW.id, v_img, NEW.image_paths);
  END IF;
  RETURN NULL;
END $$;

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

CREATE OR REPLACE FUNCTION public.listing_readiness_display_hold()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('boomer.listing_display_apply', true), '') = '1' THEN RETURN NEW; END IF;
  IF OLD.status = 'published' AND NEW.status = 'published'
     AND (NEW.image_paths IS DISTINCT FROM OLD.image_paths OR NEW.cover_url IS DISTINCT FROM OLD.cover_url
          OR NEW.image_urls IS DISTINCT FROM OLD.image_urls)
     AND NOT listing_readiness_is_ready(NEW.sku_id) THEN
    NEW.pending_display := jsonb_build_object('image_paths', NEW.image_paths, 'cover_url', NEW.cover_url,
      'image_urls', NEW.image_urls, 'held_at', now());
    NEW.image_paths := OLD.image_paths; NEW.cover_url := OLD.cover_url; NEW.image_urls := OLD.image_urls;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_readiness_display_hold ON public.commerce_listings;
CREATE TRIGGER listing_readiness_display_hold BEFORE UPDATE OF image_paths, cover_url, image_urls ON public.commerce_listings
  FOR EACH ROW EXECUTE FUNCTION public.listing_readiness_display_hold();

CREATE OR REPLACE FUNCTION public.listing_readiness_apply_pending_display(p_listing uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('boomer.listing_display_apply', '1', true);
  UPDATE commerce_listings SET image_paths = COALESCE(pending_display->'image_paths', image_paths),
    cover_url = pending_display->>'cover_url', image_urls = COALESCE(pending_display->'image_urls', '[]'::jsonb),
    pending_display = NULL, updated_at = now()
   WHERE id = p_listing AND pending_display IS NOT NULL;
  PERFORM set_config('boomer.listing_display_apply', '', true);
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_release(p_sku uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer; v_id uuid;
BEGIN
  IF NOT listing_readiness_is_ready(p_sku) THEN RETURN 0; END IF;
  FOR v_id IN SELECT x.id FROM commerce_listings x WHERE x.sku_id = p_sku AND x.pending_display IS NOT NULL
               ORDER BY x.id FOR UPDATE SKIP LOCKED LOOP
    PERFORM listing_readiness_apply_pending_display(v_id);
  END LOOP;
  UPDATE commerce_listings l SET status = 'published', updated_at = now()
   WHERE l.id IN (SELECT x.id FROM commerce_listings x
                   WHERE x.sku_id = p_sku AND x.readiness_hold AND x.status = 'hidden'
                     AND EXISTS (SELECT 1 FROM inv_stocks s WHERE s.sku_id = x.sku_id AND s.location_id = x.location_id AND s.qty > 0)
                   ORDER BY x.id FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_recheck()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF listing_readiness_is_ready(NEW.sku_id) THEN
    IF NEW.pending_display IS NOT NULL THEN PERFORM listing_readiness_apply_pending_display(NEW.id); END IF;
    UPDATE commerce_listings l SET status = 'published', updated_at = now()
     WHERE l.id = NEW.id AND l.readiness_hold AND l.status = 'hidden'
       AND EXISTS (SELECT 1 FROM inv_stocks s WHERE s.sku_id = l.sku_id AND s.location_id = l.location_id AND s.qty > 0);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.handheld_apply_listing_image_result(p_sku_id uuid, p_source_key text, p_target_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_paths text[]; v_next text[];
BEGIN
  IF p_source_key IS NULL OR p_target_key IS NULL OR p_target_key NOT LIKE 'sku-listing/%' THEN
    RAISE EXCEPTION 'invalid_image_result';
  END IF;
  SELECT image_paths INTO v_paths FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(p_source_key = ANY(v_paths), false) THEN RETURN false; END IF;
  SELECT array_agg(path ORDER BY first_ord) INTO v_next FROM (
    SELECT CASE WHEN value = p_source_key THEN p_target_key ELSE value END AS path, min(ord) AS first_ord
      FROM unnest(v_paths) WITH ORDINALITY t(value, ord) GROUP BY 1
  ) deduped;
  UPDATE public.inv_skus SET image_paths = v_next,
    image_url = CASE WHEN v_next[1] LIKE 'https://%' THEN v_next[1] ELSE NULL END,
    updated_at = now() WHERE id = p_sku_id;
  UPDATE public.commerce_listings l SET image_paths = (
    SELECT jsonb_agg(path ORDER BY first_ord) FROM (
      SELECT CASE WHEN value = p_source_key THEN p_target_key ELSE value END AS path, min(ord) AS first_ord
        FROM jsonb_array_elements_text(COALESCE(l.pending_display->'image_paths', l.image_paths)) WITH ORDINALITY t(value, ord) GROUP BY 1
    ) deduped
  ), updated_at = now()
  WHERE sku_id = p_sku_id AND status IN ('draft','published','reserved','hidden')
    AND (COALESCE(l.pending_display->'image_paths', l.image_paths) ? p_source_key);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.listing_readiness_apply_image_plan(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_smart_create_commit_v2(uuid, uuid, text, text, uuid, boolean, jsonb, text[], text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_pending_consent(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_resolve_consent(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_bump(uuid, boolean, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_on_sku_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_refresh(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_display_hold() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_apply_pending_display(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_release(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_recheck() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_apply_listing_image_result(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_smart_create_commit_v2(uuid, uuid, text, text, uuid, boolean, jsonb, text[], text, uuid, text, text),
  public.listing_readiness_pending_consent(integer), public.listing_readiness_resolve_consent(uuid, uuid, text, text),
  public.listing_readiness_refresh(uuid), public.listing_readiness_release(uuid),
  public.handheld_apply_listing_image_result(uuid, text, text) TO service_role;