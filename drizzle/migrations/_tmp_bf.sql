-- 存量自动图文详情补齐（零付费 AI）：只补当前公开、尚无详情的孤品；version CAS + 原内容备份可回滚。
ALTER TABLE public.inv_product_content ADD COLUMN IF NOT EXISTS auto_sources jsonb;
ALTER TABLE public.inv_product_content ADD COLUMN IF NOT EXISTS auto_backfill_backup jsonb;
COMMENT ON COLUMN public.inv_product_content.auto_sources IS '自动详情来源与版本：{mode, builder_version, version, sources[], at}；人工编辑后保留作历史';
COMMENT ON COLUMN public.inv_product_content.auto_backfill_backup IS '存量补齐前的原内容快照（existed/version/draft/published），供 product_content_backfill_restore 回滚';

CREATE OR REPLACE FUNCTION public.product_content_backfill_block_reason(p_sku uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN s.id IS NULL THEN 'missing_sku'
    WHEN NOT (s.status = 'active' AND s.is_display AND s.is_custom_price AND s.kind = 'single') THEN 'not_public_single'
    WHEN NOT EXISTS (SELECT 1 FROM commerce_listings l WHERE l.sku_id = s.id AND l.status = 'published') THEN 'not_published'
    WHEN EXISTS (SELECT 1 FROM listing_readiness r WHERE r.sku_id = s.id) THEN 'readiness_managed'
    WHEN EXISTS (SELECT 1 FROM commerce_listings l WHERE l.sku_id = s.id AND l.pending_display IS NOT NULL) THEN 'pending_display'
    WHEN EXISTS (SELECT 1 FROM inv_listing_image_jobs j WHERE j.sku_id = s.id AND j.status <> 'succeeded') THEN 'image_jobs_unfinished'
    WHEN EXISTS (SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id = s.id AND j.status <> 'succeeded') THEN 'detail_image_jobs_unfinished'
    WHEN EXISTS (SELECT 1 FROM inv_product_content c WHERE c.sku_id = s.id
                 AND jsonb_typeof(c.published_blocks) = 'array' AND jsonb_array_length(c.published_blocks) > 0) THEN 'has_content'
    ELSE NULL END
  FROM (SELECT p_sku AS id) x LEFT JOIN inv_skus s ON s.id = x.id
$$;

-- p_expected_version：dry-run 读到的 inv_product_content.version；NULL 表示当时没有内容行。
CREATE OR REPLACE FUNCTION public.product_content_backfill_apply(p_sku uuid, p_expected_version integer,
  p_blocks jsonb, p_sources jsonb, p_builder_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c inv_product_content; v_reason text; v_ver integer;
BEGIN
  PERFORM 1 FROM inv_skus WHERE id = p_sku FOR UPDATE;
  SELECT * INTO c FROM inv_product_content WHERE sku_id = p_sku FOR UPDATE;
  IF FOUND AND c.auto_sources->>'mode' = 'backfill' AND c.version = (c.auto_sources->>'version')::int THEN
    RETURN jsonb_build_object('status','already_filled','version',c.version);
  END IF;
  v_reason := product_content_backfill_block_reason(p_sku);
  IF v_reason IS NOT NULL THEN RETURN jsonb_build_object('status','skipped','reason',v_reason); END IF;
  IF jsonb_typeof(p_blocks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_blocks) = 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','empty_blocks');
  END IF;
  IF COALESCE(p_builder_version,'') = '' OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_backfill_args' USING ERRCODE = '22023';
  END IF;
  IF c.sku_id IS NULL THEN
    IF p_expected_version IS NOT NULL THEN RETURN jsonb_build_object('status','conflict'); END IF;
    v_ver := 1;
    INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, published_version, auto_sources, auto_backfill_backup)
    VALUES (p_sku, 1, p_blocks, p_blocks, 1,
      jsonb_build_object('mode','backfill','builder_version',p_builder_version,'version',1,'sources',p_sources,'at',now()),
      jsonb_build_object('existed', false));
  ELSE
    IF p_expected_version IS DISTINCT FROM c.version THEN RETURN jsonb_build_object('status','conflict'); END IF;
    v_ver := c.version + 1;
    UPDATE inv_product_content SET published_blocks = p_blocks,
      draft_blocks = CASE WHEN jsonb_array_length(COALESCE(draft_blocks,'[]'::jsonb)) = 0 THEN p_blocks ELSE draft_blocks END,
      version = v_ver, published_version = v_ver, updated_at = now(),
      auto_sources = jsonb_build_object('mode','backfill','builder_version',p_builder_version,'version',v_ver,'sources',p_sources,'at',now()),
      auto_backfill_backup = jsonb_build_object('existed', true, 'version', c.version, 'published_version', c.published_version,
        'draft_blocks', c.draft_blocks, 'published_blocks', c.published_blocks, 'updated_by', c.updated_by, 'updated_at', c.updated_at,
        'auto_sources', c.auto_sources)
     WHERE sku_id = p_sku;
  END IF;
  RETURN jsonb_build_object('status','filled','version',v_ver);
END $$;

-- 回滚：仅当补齐后没有人工改动（version 未变）才恢复原内容；否则保留人工编辑。
CREATE OR REPLACE FUNCTION public.product_content_backfill_restore(p_sku uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c inv_product_content; b jsonb;
BEGIN
  SELECT * INTO c FROM inv_product_content WHERE sku_id = p_sku FOR UPDATE;
  IF NOT FOUND OR c.auto_sources->>'mode' IS DISTINCT FROM 'backfill' OR c.auto_backfill_backup IS NULL THEN
    RETURN jsonb_build_object('status','not_backfilled');
  END IF;
  IF c.version IS DISTINCT FROM (c.auto_sources->>'version')::int THEN
    RETURN jsonb_build_object('status','edited_since','version',c.version);
  END IF;
  b := c.auto_backfill_backup;
  IF NOT COALESCE((b->>'existed')::boolean, false) THEN
    DELETE FROM inv_product_content WHERE sku_id = p_sku;
  ELSE
    UPDATE inv_product_content SET version = (b->>'version')::int, published_version = (b->>'published_version')::int,
      draft_blocks = b->'draft_blocks', published_blocks = b->'published_blocks',
      updated_by = (b->>'updated_by')::uuid, updated_at = (b->>'updated_at')::timestamptz,
      auto_sources = NULLIF(b->'auto_sources','null'::jsonb), auto_backfill_backup = NULL
     WHERE sku_id = p_sku;
  END IF;
  RETURN jsonb_build_object('status','restored');
END $$;

-- 详情读取同一次调用带出自动来源（不增加查询回合）。
CREATE OR REPLACE FUNCTION public.published_product_content(p_sku_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SET search_path TO ''
AS $function$
  SELECT jsonb_build_object('version',c.published_version,'published_blocks',c.published_blocks,
           'auto_sources', CASE WHEN c.version = (c.auto_sources->>'version')::int THEN c.auto_sources->'sources' END)
    FROM public.inv_product_content c JOIN public.inv_skus s ON s.id=c.sku_id
   WHERE c.sku_id=p_sku_id AND c.published_version IS NOT NULL
     AND s.status='active' AND s.is_display AND s.is_custom_price AND s.kind='single'
     AND EXISTS (SELECT 1 FROM public.commerce_listings l WHERE l.sku_id=c.sku_id AND l.status='published');
$function$;

REVOKE ALL ON FUNCTION public.product_content_backfill_block_reason(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_content_backfill_apply(uuid, integer, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_content_backfill_restore(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_content_backfill_block_reason(uuid),
  public.product_content_backfill_apply(uuid, integer, jsonb, jsonb, text),
  public.product_content_backfill_restore(uuid) TO service_role;
