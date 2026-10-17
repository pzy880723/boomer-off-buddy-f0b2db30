-- 0077 上架准备门禁纠错（增量，不改已应用 0075；0076 为误提交的空占位，无任何语句）。
-- 1 删除 10 分钟超时放行；2 所有新建 SKU 入库同事务建立准备记录；3 输入修订 + 图片回调 fencing；
-- 4 详情图片任务阻断；5 显式下架/归档取消待发布意图；6 放行锁序 readiness→listing(SKIP LOCKED)，提交复核只改自身行。
ALTER TABLE public.listing_readiness ADD COLUMN IF NOT EXISTS image_input_revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.listing_readiness ADD COLUMN IF NOT EXISTS auto_content_version integer;
COMMENT ON COLUMN public.listing_readiness.image_input_revision IS '最近一次照片输入变化时的 input_revision；只有不早于此修订的图片任务计入';
COMMENT ON COLUMN public.listing_readiness.auto_content_version IS '自动模板写入的 inv_product_content.version；不相等即视为人工内容，保留不覆盖';

CREATE OR REPLACE FUNCTION public.listing_readiness_detail_images_state(p_sku uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id = p_sku AND j.status IN ('queued','processing','retryable_failed')) THEN 'running'
    WHEN EXISTS (SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id = p_sku AND j.status = 'permanent_failed') THEN 'failed'
    ELSE 'succeeded' END
$$;

CREATE OR REPLACE FUNCTION public.listing_readiness_is_ready(p_sku uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT r.images_settled
       AND r.recognition_status = 'succeeded' AND r.recognition_revision = r.input_revision
       AND r.image_status = 'succeeded' AND r.image_revision = r.input_revision
       AND r.content_status = 'succeeded' AND r.content_revision = r.input_revision
       AND listing_readiness_detail_images_state(p_sku) = 'succeeded'
       AND EXISTS (SELECT 1 FROM inv_product_content c WHERE c.sku_id = p_sku
                   AND jsonb_typeof(c.published_blocks) = 'array' AND jsonb_array_length(c.published_blocks) > 0)
    FROM listing_readiness r WHERE r.sku_id = p_sku), true)
$$;

CREATE OR REPLACE FUNCTION public.listing_readiness_has_raw(p_paths text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM unnest(COALESCE(p_paths, '{}'::text[])) p WHERE p LIKE 'sku-raw/%')
$$;

CREATE OR REPLACE FUNCTION public.listing_readiness_on_sku_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO listing_readiness (sku_id, images_settled)
  VALUES (NEW.id, NOT listing_readiness_has_raw(NEW.image_paths)) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_bump(p_sku uuid, p_images boolean, p_paths text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; v_rev integer; v_actor uuid; v_policy text; v_settled boolean;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_rev := r.input_revision + 1;
  v_settled := r.images_settled;
  IF p_images THEN
    v_settled := NOT listing_readiness_has_raw(p_paths);
    IF NOT v_settled THEN
      SELECT ai_actor_user_id, ai_policy_version INTO v_actor, v_policy FROM inv_listing_image_jobs
       WHERE sku_id = p_sku AND ai_actor_user_id IS NOT NULL ORDER BY created_at DESC LIMIT 1;
      IF v_actor IS NULL THEN
        v_settled := true;
      ELSE
        INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, source_index, ai_actor_user_id,
          ai_policy_version, target_bucket, status, next_run_at, readiness_revision)
        SELECT p_sku, 'sku-raw', substring(p FROM length('sku-raw/') + 1), (o - 1)::int, v_actor, v_policy,
               'sku-listing', 'queued', now(), v_rev
          FROM unnest(p_paths) WITH ORDINALITY t(p, o) WHERE p LIKE 'sku-raw/%'
        ON CONFLICT (sku_id, source_bucket, source_path) DO UPDATE SET status = 'queued', attempts = 0,
          readiness_revision = EXCLUDED.readiness_revision, next_run_at = now(), last_error = NULL, claim_token = NULL,
          lease_until = NULL, locked_at = NULL, locked_by = NULL, completed_at = NULL, updated_at = now();
        v_settled := true;
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
  IF v_img OR NEW.name IS DISTINCT FROM OLD.name OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.grade IS DISTINCT FROM OLD.grade
     OR NEW.ip_id IS DISTINCT FROM OLD.ip_id THEN
    PERFORM listing_readiness_bump(NEW.id, v_img, NEW.image_paths);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS listing_readiness_sku_update ON public.inv_skus;
CREATE TRIGGER listing_readiness_sku_update AFTER UPDATE OF image_paths, name, category, brand_id, grade, ip_id
  ON public.inv_skus FOR EACH ROW EXECUTE FUNCTION public.listing_readiness_on_sku_update();

CREATE OR REPLACE FUNCTION public.listing_readiness_on_facet_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM listing_readiness_bump(COALESCE(NEW.sku_id, OLD.sku_id), false, NULL);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS listing_readiness_facet_change ON public.inv_sku_facets;
CREATE TRIGGER listing_readiness_facet_change AFTER INSERT OR UPDATE OR DELETE ON public.inv_sku_facets
  FOR EACH ROW EXECUTE FUNCTION public.listing_readiness_on_facet_change();

CREATE OR REPLACE FUNCTION public.listing_readiness_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    IF NOT listing_readiness_is_ready(NEW.sku_id) THEN
      NEW.status := 'hidden';
      NEW.readiness_hold := true;
      IF TG_OP = 'INSERT' OR OLD.readiness_hold OR OLD.published_at IS NULL THEN
        NEW.published_at := NULL;
      END IF;
    ELSE
      NEW.readiness_hold := false;
      NEW.published_at := COALESCE(NEW.published_at, now());
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.readiness_hold
        AND (NOT NEW.readiness_hold OR NEW.status IS DISTINCT FROM OLD.status) THEN
    NEW.readiness_hold := false;
    NEW.published_at := OLD.published_at;
  ELSIF NEW.readiness_hold AND (TG_OP = 'INSERT' OR OLD.readiness_hold) THEN
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_release(p_sku uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  IF NOT listing_readiness_is_ready(p_sku) THEN RETURN 0; END IF;
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
    UPDATE commerce_listings l SET status = 'published', updated_at = now()
     WHERE l.id = NEW.id AND l.readiness_hold AND l.status = 'hidden'
       AND EXISTS (SELECT 1 FROM inv_stocks s WHERE s.sku_id = l.sku_id AND s.location_id = l.location_id AND s.qty > 0);
  END IF;
  RETURN NULL;
END $$;

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
  ELSIF listing_readiness_has_raw(s.image_paths) THEN r.image_status := 'failed'; r.last_error := COALESCE(r.last_error, 'raw_image_unprocessed');
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

CREATE OR REPLACE FUNCTION public.listing_readiness_publish_content(
  p_sku uuid, p_revision integer, p_blocks jsonb, p_sources jsonb, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; c inv_product_content; v_mode text; v_has boolean; v_ver integer;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  IF p_revision IS DISTINCT FROM r.input_revision THEN RETURN jsonb_build_object('status','stale'); END IF;
  IF r.content_status = 'succeeded' AND r.content_revision = r.input_revision THEN
    RETURN jsonb_build_object('status','replayed','released',listing_readiness_release(p_sku));
  END IF;
  SELECT * INTO c FROM inv_product_content WHERE sku_id = p_sku FOR UPDATE;
  v_has := FOUND AND jsonb_typeof(c.published_blocks) = 'array' AND jsonb_array_length(c.published_blocks) > 0;
  IF v_has AND (r.auto_content_version IS NULL OR c.version IS DISTINCT FROM r.auto_content_version) THEN
    v_mode := 'reused_existing';
    UPDATE listing_readiness SET content_status = 'succeeded', content_revision = r.input_revision,
      content_mode = v_mode, last_error = NULL, updated_at = now() WHERE sku_id = p_sku;
    RETURN jsonb_build_object('status', v_mode, 'released', listing_readiness_release(p_sku));
  END IF;
  IF jsonb_typeof(p_blocks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_blocks) = 0 THEN
    UPDATE listing_readiness SET content_status = 'failed', last_error = 'empty_content', updated_at = now() WHERE sku_id = p_sku;
    RETURN jsonb_build_object('status','failed');
  END IF;
  IF c.sku_id IS NOT NULL THEN
    v_ver := c.version + 1;
    UPDATE inv_product_content SET published_blocks = p_blocks,
      draft_blocks = CASE WHEN jsonb_array_length(COALESCE(draft_blocks,'[]'::jsonb)) = 0
                            OR draft_blocks = c.published_blocks THEN p_blocks ELSE draft_blocks END,
      version = v_ver, published_version = v_ver, updated_at = now()
     WHERE sku_id = p_sku;
    v_mode := CASE WHEN v_has THEN 'template_replaced' ELSE 'template' END;
  ELSE
    v_ver := 1;
    INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, published_version)
    VALUES (p_sku, 1, p_blocks, p_blocks, 1);
    v_mode := 'template';
  END IF;
  UPDATE listing_readiness SET content_status = 'succeeded', content_revision = r.input_revision,
    content_mode = COALESCE(p_mode, 'template'), content_sources = COALESCE(p_sources,'[]'::jsonb),
    auto_content_version = v_ver, last_error = NULL, updated_at = now() WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status', v_mode, 'released', listing_readiness_release(p_sku));
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_retry(p_sku uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; v_jobs int; v_detail int;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  UPDATE inv_listing_image_jobs SET status = 'queued', attempts = 0, next_run_at = now(), last_error = NULL,
    locked_at = NULL, locked_by = NULL, claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE sku_id = p_sku AND readiness_revision >= r.image_input_revision AND status = 'permanent_failed';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  UPDATE inv_product_content_image_jobs SET status = 'queued', attempts = 0, next_run_at = now(), last_error = NULL,
    claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE sku_id = p_sku AND status = 'permanent_failed';
  GET DIAGNOSTICS v_detail = ROW_COUNT;
  UPDATE listing_readiness SET content_status = CASE WHEN content_status = 'failed' THEN 'pending' ELSE content_status END,
    last_error = NULL, updated_at = now() WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status','ok','requeued_images',v_jobs,'requeued_detail_images',v_detail,
    'images_settled', r.images_settled);
END $$;

CREATE OR REPLACE FUNCTION public.handheld_listing_image_finish(p_id uuid, p_claim_token uuid, p_target_path text, p_error text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.inv_listing_image_jobs; v_sku public.inv_skus; v_status text; v_error text; v_prefix text;
  v_img_rev integer; v_applied boolean;
BEGIN
  SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=p_id;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_job.sku_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'processing' OR p_claim_token IS NULL
    OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until IS NULL
    OR v_job.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  SELECT image_input_revision INTO v_img_rev FROM public.listing_readiness WHERE sku_id = v_job.sku_id;
  v_error := CASE
    WHEN v_img_rev IS NOT NULL AND COALESCE(v_job.readiness_revision, 0) < v_img_rev THEN 'stale_input_revision'
    WHEN v_sku.status IS DISTINCT FROM 'active' THEN 'sku_not_active'
    WHEN NOT coalesce((v_job.source_bucket||'/'||v_job.source_path)=ANY(v_sku.image_paths),false)
      THEN 'source_removed_not_applied' ELSE NULL END;
  IF v_error IS NOT NULL THEN v_status := 'permanent_failed';
  ELSIF p_error IS NOT NULL THEN
    v_error := left(p_error,1000);
    v_status := CASE WHEN v_job.attempts>=5 OR p_error LIKE 'permanent:%' OR p_error LIKE 'ai_consent_missing%'
      THEN 'permanent_failed' ELSE 'retryable_failed' END;
  ELSE
    v_prefix := 'sku-listing/gallery/'||v_job.sku_id::text||'/'||v_job.id::text||'/'||p_claim_token::text;
    IF p_target_path IS NULL OR p_target_path NOT IN (v_prefix||'.png',v_prefix||'.jpg',v_prefix||'.webp')
      OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='sku-listing'
        AND name=substring(p_target_path FROM length('sku-listing/')+1)) THEN
      RAISE EXCEPTION 'invalid_listing_image_target';
    END IF;
    PERFORM set_config('boomer.listing_image_apply', '1', true);
    v_applied := public.handheld_apply_listing_image_result(v_job.sku_id,
      v_job.source_bucket||'/'||v_job.source_path,p_target_path);
    PERFORM set_config('boomer.listing_image_apply', '', true);
    IF v_applied THEN v_status := 'succeeded';
    ELSE v_status := 'permanent_failed'; v_error := 'source_removed_not_applied';
    END IF;
  END IF;
  UPDATE public.inv_listing_image_jobs SET status=v_status,
    target_path=CASE WHEN v_status='succeeded' THEN substring(p_target_path FROM length('sku-listing/')+1) ELSE target_path END,
    last_error=v_error,lease_until=NULL,locked_at=NULL,locked_by=NULL,updated_at=now(),
    completed_at=CASE WHEN v_status='succeeded' THEN now() ELSE completed_at END,
    next_run_at=CASE WHEN v_status='retryable_failed' THEN now()+make_interval(secs=>
      CASE v_job.attempts WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END)
      ELSE next_run_at END
    WHERE id=p_id;
  PERFORM public.handheld_listing_image_refresh_status(v_job.sku_id);
  RETURN v_status;
END $$;

REVOKE ALL ON FUNCTION public.listing_readiness_detail_images_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_has_raw(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_bump(uuid, boolean, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_on_sku_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_on_facet_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_listing_image_finish(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_listing_image_finish(uuid, uuid, text, text) TO service_role;