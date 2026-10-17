-- 0086：系统模板写商品详情时 updated_by 使用固定的“系统自动化”审计身份（真实表 updated_by NOT NULL，无外键）。
-- 不冒充上传员工、不放宽 NOT NULL；人工编辑路径仍写真实员工；回滚仍恢复备份里的原 updated_by。
CREATE OR REPLACE FUNCTION public.content_system_actor()
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 'a0700000-0000-4000-8000-000000000001'::uuid $$;
COMMENT ON FUNCTION public.content_system_actor() IS '系统自动化审计身份（非员工、无授权、不在 auth.users）：仅用于系统模板/存量补齐写 inv_product_content.updated_by';
REVOKE ALL ON FUNCTION public.content_system_actor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_system_actor() TO service_role;

CREATE OR REPLACE FUNCTION public.listing_readiness_publish_content(p_sku uuid, p_revision integer, p_blocks jsonb, p_sources jsonb, p_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      version = v_ver, published_version = v_ver, updated_by = content_system_actor(), updated_at = now()
     WHERE sku_id = p_sku;
    v_mode := CASE WHEN v_has THEN 'template_replaced' ELSE 'template' END;
  ELSE
    v_ver := 1;
    INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, published_version, updated_by)
    VALUES (p_sku, 1, p_blocks, p_blocks, 1, content_system_actor());
    v_mode := 'template';
  END IF;
  UPDATE listing_readiness SET content_status = 'succeeded', content_revision = r.input_revision,
    content_mode = COALESCE(p_mode, 'template'), content_sources = COALESCE(p_sources,'[]'::jsonb),
    auto_content_version = v_ver, last_error = NULL, updated_at = now() WHERE sku_id = p_sku;
  RETURN jsonb_build_object('status', v_mode, 'released', listing_readiness_release(p_sku));
END $function$;

CREATE OR REPLACE FUNCTION public.product_content_backfill_apply(p_sku uuid, p_expected_version integer, p_blocks jsonb, p_sources jsonb, p_builder_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, published_version, updated_by, auto_sources, auto_backfill_backup)
    VALUES (p_sku, 1, p_blocks, p_blocks, 1, content_system_actor(),
      jsonb_build_object('mode','backfill','builder_version',p_builder_version,'version',1,'sources',p_sources,'at',now()),
      jsonb_build_object('existed', false));
  ELSE
    IF p_expected_version IS DISTINCT FROM c.version THEN RETURN jsonb_build_object('status','conflict'); END IF;
    v_ver := c.version + 1;
    UPDATE inv_product_content SET published_blocks = p_blocks,
      draft_blocks = CASE WHEN jsonb_array_length(COALESCE(draft_blocks,'[]'::jsonb)) = 0 THEN p_blocks ELSE draft_blocks END,
      version = v_ver, published_version = v_ver, updated_by = content_system_actor(), updated_at = now(),
      auto_sources = jsonb_build_object('mode','backfill','builder_version',p_builder_version,'version',v_ver,'sources',p_sources,'at',now()),
      auto_backfill_backup = jsonb_build_object('existed', true, 'version', c.version, 'published_version', c.published_version,
        'draft_blocks', c.draft_blocks, 'published_blocks', c.published_blocks, 'updated_by', c.updated_by, 'updated_at', c.updated_at,
        'auto_sources', c.auto_sources)
     WHERE sku_id = p_sku;
  END IF;
  RETURN jsonb_build_object('status','filled','version',v_ver);
END $function$;
