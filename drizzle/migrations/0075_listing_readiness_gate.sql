-- 新上架准备门禁：同一输入修订下 识别/图片/详情 全部成功才允许公开上架。
-- 旧商品（无准备记录）与已公开 listing 不受影响；只拦截“变成 published”的那次转换。
CREATE TABLE IF NOT EXISTS public.listing_readiness (
  sku_id uuid PRIMARY KEY REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  input_revision integer NOT NULL DEFAULT 1 CHECK (input_revision >= 1),
  recognition_status text NOT NULL DEFAULT 'pending',
  recognition_revision integer,
  image_status text NOT NULL DEFAULT 'pending',
  image_revision integer,
  images_settled boolean NOT NULL DEFAULT false,
  content_status text NOT NULL DEFAULT 'pending',
  content_revision integer,
  content_mode text,
  content_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_readiness_status_chk CHECK (
    recognition_status IN ('pending','running','succeeded','failed') AND
    image_status IN ('pending','running','succeeded','failed') AND
    content_status IN ('pending','running','succeeded','failed'))
);
GRANT ALL ON public.listing_readiness TO service_role;
REVOKE ALL ON public.listing_readiness FROM PUBLIC, anon, authenticated;
ALTER TABLE public.listing_readiness ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.commerce_listings ADD COLUMN IF NOT EXISTS readiness_hold boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.commerce_listings.readiness_hold IS '已发起上架意图但准备未完成：保持 hidden 且 published_at 为空，就绪后自动发布';
ALTER TABLE public.inv_listing_image_jobs ADD COLUMN IF NOT EXISTS readiness_revision integer;

CREATE OR REPLACE FUNCTION public.listing_readiness_is_ready(p_sku uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT r.recognition_status = 'succeeded' AND r.recognition_revision = r.input_revision
       AND r.image_status = 'succeeded' AND r.image_revision = r.input_revision
       AND r.content_status = 'succeeded' AND r.content_revision = r.input_revision
       AND EXISTS (SELECT 1 FROM inv_product_content c WHERE c.sku_id = p_sku
                   AND jsonb_typeof(c.published_blocks) = 'array' AND jsonb_array_length(c.published_blocks) > 0)
    FROM listing_readiness r WHERE r.sku_id = p_sku), true)
$$;

-- 新建自定义孤品：自动建立准备记录（只对迁移后新建商品生效）。
CREATE OR REPLACE FUNCTION public.listing_readiness_on_sku_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_custom_price AND COALESCE(NEW.kind,'single') = 'single'
     AND COALESCE(NEW.inventory_policy,'tracked') <> 'unlimited' THEN
    INSERT INTO listing_readiness (sku_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_readiness_sku_insert ON public.inv_skus;
CREATE TRIGGER listing_readiness_sku_insert AFTER INSERT ON public.inv_skus
  FOR EACH ROW EXECUTE FUNCTION public.listing_readiness_on_sku_insert();

-- 统一门禁：任何写入路径把 listing 变成 published 时检查；未就绪改为 hidden + 记录意图。
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
  ELSIF NEW.readiness_hold AND (TG_OP = 'INSERT' OR OLD.readiness_hold) THEN
    -- 准备中被售出/预留/归档：仍不对公众可读（详情要求 published_at 非空）。
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_readiness_gate ON public.commerce_listings;
CREATE TRIGGER listing_readiness_gate BEFORE INSERT OR UPDATE ON public.commerce_listings
  FOR EACH ROW EXECUTE FUNCTION public.listing_readiness_gate();

-- 就绪后发布已发起意图、且该店确有正库存的 listing。锁序：listing_readiness →（读库存）→ listing。
CREATE OR REPLACE FUNCTION public.listing_readiness_release(p_sku uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  IF NOT listing_readiness_is_ready(p_sku) THEN RETURN 0; END IF;
  UPDATE commerce_listings l SET status = 'published', updated_at = now()
   WHERE l.sku_id = p_sku AND l.readiness_hold AND l.status = 'hidden'
     AND EXISTS (SELECT 1 FROM inv_stocks s WHERE s.sku_id = l.sku_id AND s.location_id = l.location_id AND s.qty > 0);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- 提交时复核：门禁读到“未就绪”后，若就绪在本事务提交前已完成，提交时补发布（关闭竞态窗口）。
CREATE OR REPLACE FUNCTION public.listing_readiness_recheck()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.readiness_hold THEN PERFORM listing_readiness_release(NEW.sku_id); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS listing_readiness_recheck ON public.commerce_listings;
CREATE CONSTRAINT TRIGGER listing_readiness_recheck AFTER INSERT OR UPDATE ON public.commerce_listings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.readiness_hold)
  EXECUTE FUNCTION public.listing_readiness_recheck();

-- 由真实数据推导识别/图片状态（幂等：重复回调只是再推导一次）。
CREATE OR REPLACE FUNCTION public.listing_readiness_refresh(p_sku uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; s inv_skus; v_open int; v_failed int; v_ok int; v_err text;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  SELECT * INTO s FROM inv_skus WHERE id = p_sku;
  r.last_error := NULL;
  IF COALESCE(btrim(s.name),'') <> '' AND COALESCE(btrim(s.category),'') <> '' THEN
    r.recognition_status := 'succeeded';
  ELSE r.recognition_status := 'failed'; v_err := 'missing_category';
  END IF;
  r.recognition_revision := r.input_revision;
  SELECT count(*) FILTER (WHERE status IN ('queued','processing','retryable_failed')),
         count(*) FILTER (WHERE status = 'permanent_failed'),
         count(*) FILTER (WHERE status = 'succeeded'),
         max(last_error) FILTER (WHERE status = 'permanent_failed')
    INTO v_open, v_failed, v_ok, v_err
    FROM inv_listing_image_jobs WHERE sku_id = p_sku AND readiness_revision = r.input_revision;
  IF v_open > 0 THEN r.image_status := 'running';
  ELSIF v_failed > 0 THEN r.image_status := 'failed'; r.last_error := COALESCE(v_err,'image_failed');
  ELSIF v_ok > 0 THEN r.image_status := 'succeeded';
  ELSIF r.images_settled OR r.created_at < now() - interval '10 minutes' THEN
    IF COALESCE(array_length(s.image_paths,1),0) > 0 OR s.image_url IS NOT NULL THEN r.image_status := 'succeeded';
    ELSE r.image_status := 'failed'; r.last_error := 'missing_images'; END IF;
  ELSE r.image_status := 'pending';
  END IF;
  r.image_revision := r.input_revision;
  IF r.recognition_status = 'failed' THEN r.last_error := 'missing_category'; END IF;
  UPDATE listing_readiness SET recognition_status = r.recognition_status, recognition_revision = r.recognition_revision,
    image_status = r.image_status, image_revision = r.image_revision, last_error = r.last_error, updated_at = now()
   WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status','ok','input_revision',r.input_revision,'recognition',r.recognition_status,
    'image',r.image_status,'content',r.content_status,'content_revision',r.content_revision,
    'released',listing_readiness_release(p_sku));
END $$;

-- 自动图文详情落库（版本 CAS）：已有发布内容（含人工编辑）直接复用，不覆盖、不调 AI。
CREATE OR REPLACE FUNCTION public.listing_readiness_publish_content(
  p_sku uuid, p_revision integer, p_blocks jsonb, p_sources jsonb, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; c inv_product_content; v_mode text;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  IF p_revision IS DISTINCT FROM r.input_revision THEN RETURN jsonb_build_object('status','stale'); END IF;
  IF r.content_status = 'succeeded' AND r.content_revision = r.input_revision THEN
    RETURN jsonb_build_object('status','replayed','released',listing_readiness_release(p_sku));
  END IF;
  SELECT * INTO c FROM inv_product_content WHERE sku_id = p_sku FOR UPDATE;
  IF FOUND AND jsonb_typeof(c.published_blocks) = 'array' AND jsonb_array_length(c.published_blocks) > 0 THEN
    v_mode := 'reused_existing';
  ELSE
    IF jsonb_typeof(p_blocks) <> 'array' OR jsonb_array_length(p_blocks) = 0 THEN
      UPDATE listing_readiness SET content_status = 'failed', last_error = 'empty_content', updated_at = now() WHERE sku_id = p_sku;
      RETURN jsonb_build_object('status','failed');
    END IF;
    IF FOUND THEN
      UPDATE inv_product_content SET published_blocks = p_blocks,
        draft_blocks = CASE WHEN jsonb_array_length(COALESCE(draft_blocks,'[]'::jsonb)) = 0 THEN p_blocks ELSE draft_blocks END,
        version = version + 1, published_version = version + 1, updated_at = now()
       WHERE sku_id = p_sku;
    ELSE
      INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, published_version)
      VALUES (p_sku, 1, p_blocks, p_blocks, 1);
    END IF;
    v_mode := COALESCE(p_mode, 'template');
  END IF;
  UPDATE listing_readiness SET content_status = 'succeeded', content_revision = r.input_revision,
    content_mode = v_mode, content_sources = CASE WHEN v_mode = 'reused_existing' THEN content_sources ELSE COALESCE(p_sources,'[]'::jsonb) END,
    last_error = NULL, updated_at = now() WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status', v_mode, 'released', listing_readiness_release(p_sku));
END $$;

CREATE OR REPLACE FUNCTION public.listing_readiness_mark_images_settled(p_sku uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE listing_readiness SET images_settled = true, updated_at = now() WHERE sku_id = p_sku;
$$;

-- ERP 重试：只重置当前修订下的失败图片任务与失败详情步骤；不改输入、不碰库存。
CREATE OR REPLACE FUNCTION public.listing_readiness_retry(p_sku uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r listing_readiness; v_jobs int;
BEGIN
  SELECT * INTO r FROM listing_readiness WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF;
  UPDATE inv_listing_image_jobs SET status = 'queued', attempts = 0, next_run_at = now(), last_error = NULL,
    locked_at = NULL, locked_by = NULL, claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE sku_id = p_sku AND readiness_revision = r.input_revision AND status = 'permanent_failed';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  UPDATE listing_readiness SET content_status = CASE WHEN content_status = 'failed' THEN 'pending' ELSE content_status END,
    last_error = NULL, updated_at = now() WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status','ok','requeued_images',v_jobs);
END $$;

REVOKE ALL ON FUNCTION public.listing_readiness_is_ready(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_release(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_refresh(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_publish_content(uuid, integer, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_mark_images_settled(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_retry(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_on_sku_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_gate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listing_readiness_recheck() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_readiness_is_ready(uuid), public.listing_readiness_release(uuid),
  public.listing_readiness_refresh(uuid), public.listing_readiness_publish_content(uuid, integer, jsonb, jsonb, text),
  public.listing_readiness_mark_images_settled(uuid), public.listing_readiness_retry(uuid) TO service_role;