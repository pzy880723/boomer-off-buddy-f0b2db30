CREATE OR REPLACE FUNCTION public.handheld_item_update(
  p_device_id uuid, p_user_id uuid, p_client_op_id text, p_location_id uuid,
  p_sku_id uuid, p_expected_updated_at timestamptz, p_patch jsonb, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_replay jsonb; v_actor jsonb; v_sku public.inv_skus; v_after public.inv_skus;
  v_key text; v_fields text[] := '{}';
  v_name text; v_price numeric; v_notes text; v_grade text;
  v_images text[]; v_path text; v_bucket text; v_object text;
  v_op_id uuid := gen_random_uuid(); v_resp jsonb; v_queued integer := 0;
BEGIN
  v_replay := public.handheld_item_replay(p_device_id, p_client_op_id, 'update', p_user_id,
                                          p_location_id, p_sku_id, p_fingerprint);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_actor := public.handheld_item_actor(p_user_id, p_location_id);
  IF NOT (v_actor->>'hq')::boolean AND NOT (v_actor->>'manager')::boolean THEN
    PERFORM public.handheld_item_fail('edit_forbidden', '仅总部或本店店长可以修改商品');
  END IF;

  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.handheld_item_fail('not_found', '商品不存在'); END IF;
  IF v_sku.status <> 'active' THEN PERFORM public.handheld_item_fail('sku_archived', '商品已归档，不能修改'); END IF;
  IF NOT (v_actor->>'hq')::boolean AND NOT EXISTS (
       SELECT 1 FROM public.inv_stocks WHERE sku_id = p_sku_id AND location_id = p_location_id) THEN
    PERFORM public.handheld_item_fail('location_forbidden', '该商品不属于当前库位');
  END IF;
  IF NOT coalesce(v_sku.is_custom_price, false) THEN
    PERFORM public.handheld_item_fail('standard_readonly', '标准品为只读商品，不能在手机端修改');
  END IF;
  IF p_expected_updated_at IS NULL OR
     date_trunc('milliseconds', v_sku.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    PERFORM public.handheld_item_fail('version_conflict', v_sku.updated_at::text);
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    PERFORM public.handheld_item_fail('validation_error', '至少修改一个字段');
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key NOT IN ('name','price_tier','notes','grade','image_paths') THEN
      PERFORM public.handheld_item_fail('validation_error', '不允许修改字段 ' || v_key);
    END IF;
  END LOOP;

  v_name := v_sku.name; v_price := v_sku.price_tier; v_notes := v_sku.notes; v_grade := v_sku.grade;
  IF p_patch ? 'name' THEN
    v_name := btrim(p_patch->>'name');
    IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 200 THEN
      PERFORM public.handheld_item_fail('validation_error', '名称需为 1-200 字');
    END IF;
  END IF;
  IF p_patch ? 'price_tier' THEN
    IF jsonb_typeof(p_patch->'price_tier') <> 'number' THEN
      PERFORM public.handheld_item_fail('validation_error', '价格必须为数字（元）');
    END IF;
    v_price := (p_patch->>'price_tier')::numeric;
    IF v_price <= 0 OR v_price >= 1000000 OR v_price <> round(v_price, 2) THEN
      PERFORM public.handheld_item_fail('validation_error', '价格以元为单位，需大于 0 且最多两位小数');
    END IF;
  END IF;
  IF p_patch ? 'notes' THEN
    v_notes := nullif(btrim(p_patch->>'notes'), '');
    IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN
      PERFORM public.handheld_item_fail('validation_error', '描述最多 2000 字');
    END IF;
  END IF;
  IF p_patch ? 'grade' THEN
    v_grade := p_patch->>'grade';
    IF v_grade IS NOT NULL AND v_grade NOT IN ('N','S','A','B','C','J') THEN
      PERFORM public.handheld_item_fail('validation_error', '成色仅支持 N/S/A/B/C/J');
    END IF;
  END IF;


  v_images := coalesce(v_sku.image_paths, '{}'::text[]);
  IF p_patch ? 'image_paths' THEN
    IF jsonb_typeof(p_patch->'image_paths') <> 'array' THEN
      PERFORM public.handheld_item_fail('validation_error', '图片必须为数组');
    END IF;
    IF jsonb_array_length(p_patch->'image_paths') > 20 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_patch->'image_paths') e WHERE jsonb_typeof(e) <> 'string'
    ) THEN
      PERFORM public.handheld_item_fail('validation_error', '图片数量或格式不正确');
    END IF;
    SELECT coalesce(array_agg(value ORDER BY ord), '{}'::text[]) INTO v_images
      FROM jsonb_array_elements_text(p_patch->'image_paths') WITH ORDINALITY AS t(value, ord);
    IF cardinality(v_images) <> (SELECT count(DISTINCT x) FROM unnest(v_images) x) THEN
      PERFORM public.handheld_item_fail('validation_error', '图片不能重复');
    END IF;
    FOREACH v_path IN ARRAY v_images LOOP
      IF length(v_path) NOT BETWEEN 1 AND 2048 OR v_path ~ '[?#[:space:]]'
         OR '..' = ANY(string_to_array(v_path, '/'))
         OR v_path !~ '^(sku-raw/|sku-listing/|https://)' THEN
        PERFORM public.handheld_item_fail('validation_error', '图片路径不正确');
      END IF;
      -- Existing references may be reordered. New references must be this device's completed uploads.
      IF NOT (v_path = ANY(coalesce(v_sku.image_paths, '{}'::text[])))
         AND v_path IS DISTINCT FROM v_sku.image_url THEN
        v_bucket := split_part(v_path, '/', 1);
        v_object := substring(v_path FROM length(v_bucket) + 2);
        IF v_bucket NOT IN ('sku-raw','sku-listing')
           OR split_part(v_object, '/', 2) <> p_device_id::text
           OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = v_bucket AND name = v_object) THEN
          PERFORM public.handheld_item_fail('validation_error', '图片未上传完成或不属于当前设备');
        END IF;
      END IF;
    END LOOP;
    IF v_images IS DISTINCT FROM coalesce(v_sku.image_paths, '{}'::text[])
       OR (cardinality(v_images) = 0 AND v_sku.image_url IS NOT NULL) THEN
      v_fields := v_fields || 'image_paths'::text;
    END IF;
  END IF;

  IF v_name IS DISTINCT FROM v_sku.name THEN v_fields := v_fields || 'name'::text; END IF;
  IF v_price IS DISTINCT FROM v_sku.price_tier THEN v_fields := v_fields || 'price_tier'::text; END IF;
  IF v_notes IS DISTINCT FROM v_sku.notes THEN v_fields := v_fields || 'notes'::text; END IF;
  IF v_grade IS DISTINCT FROM v_sku.grade THEN v_fields := v_fields || 'grade'::text; END IF;

  IF cardinality(v_fields) > 0 THEN
    UPDATE public.inv_skus
       SET name = v_name, price_tier = v_price, notes = v_notes, grade = v_grade,
           image_paths = CASE WHEN p_patch ? 'image_paths' THEN v_images ELSE image_paths END,
           image_url = CASE WHEN p_patch ? 'image_paths'
             THEN CASE WHEN v_images[1] LIKE 'https://%' THEN v_images[1] ELSE NULL END ELSE image_url END,
           updated_at = now()
     WHERE id = p_sku_id RETURNING * INTO v_after;
    UPDATE public.commerce_listings
       SET title = v_name, price = v_price, description = v_notes, condition_grade = v_grade,
           image_paths = CASE WHEN 'image_paths' = ANY(v_fields) THEN to_jsonb(v_images) ELSE image_paths END,
           image_urls = CASE WHEN 'image_paths' = ANY(v_fields) THEN '[]'::jsonb ELSE image_urls END,
           cover_url = CASE WHEN 'image_paths' = ANY(v_fields) THEN NULL ELSE cover_url END,
           updated_at = now()
     WHERE sku_id = p_sku_id AND status IN ('draft','published','reserved','hidden');
  ELSE
    v_after := v_sku;
  END IF;

  v_resp := jsonb_build_object('ok', true, 'sku_id', p_sku_id, 'updated_at', v_after.updated_at,
    'changed_fields', to_jsonb(v_fields), 'replayed', false);
  INSERT INTO public.handheld_item_ops (id, device_id, client_op_id, op_type, user_id, location_id, sku_id, fingerprint, response)
  VALUES (v_op_id, p_device_id, p_client_op_id, 'update', p_user_id, p_location_id, p_sku_id, p_fingerprint, v_resp);

  IF v_fields && ARRAY['name','price_tier']::text[] THEN
    INSERT INTO public.handheld_youzan_item_sync_outbox (sku_id, shop_id, source_op_id)
    SELECT l.sku_id, l.shop_id, v_op_id
      FROM public.sku_youzan_links l
     WHERE l.sku_id = p_sku_id AND l.role = 'branch_stock' AND l.status = 'linked'
       AND l.sync_stock AND l.yz_item_id > 0
       AND EXISTS (SELECT 1 FROM public.sku_channel_listings c
                    WHERE c.sku_id = l.sku_id AND c.shop_id = l.shop_id
                      AND c.channel = 'youzan_branch_offline' AND c.listing_status = 'published')
    ON CONFLICT (sku_id, shop_id) WHERE status IN ('pending','failed')
    DO UPDATE SET source_op_id = EXCLUDED.source_op_id, status = 'pending',
                  next_attempt_at = now(), updated_at = now();
    GET DIAGNOSTICS v_queued = ROW_COUNT;
  END IF;
  v_resp := v_resp || jsonb_build_object('youzan_sync_queued', v_queued);
  UPDATE public.handheld_item_ops SET response = v_resp WHERE id = v_op_id;

  INSERT INTO public.handheld_item_audit (op_id, sku_id, action, actor_user_id, device_id, location_id,
                                          before_snapshot, after_snapshot, changed_fields)
  VALUES (v_op_id, p_sku_id, 'update', p_user_id, p_device_id, p_location_id,
          to_jsonb(v_sku), to_jsonb(v_after), v_fields);
  RETURN v_resp;
END;
$$;

-- Serialize AI completion with manual image edits on the SKU row. A removed source stays removed.
CREATE OR REPLACE FUNCTION public.handheld_apply_listing_image_result(
  p_sku_id uuid, p_source_key text, p_target_key text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paths text[]; v_next text[];
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
        FROM jsonb_array_elements_text(l.image_paths) WITH ORDINALITY t(value, ord) GROUP BY 1
    ) deduped
  ), updated_at = now()
  WHERE sku_id = p_sku_id AND status IN ('draft','published','reserved','hidden')
    AND image_paths ? p_source_key;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.handheld_apply_listing_image_result(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_apply_listing_image_result(uuid,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
