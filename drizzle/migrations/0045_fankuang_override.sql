-- 翻筐乐：NULL=按售价自动（<=49.9），true/false=人工覆盖，false 永远压过价格与旧标签。
ALTER TABLE public.inv_skus ADD COLUMN IF NOT EXISTS fankuang_override boolean;
COMMENT ON COLUMN public.inv_skus.fankuang_override IS 'Bargain-basket override: NULL=auto by price (<=49.9), true/false=manual override. Only tracked custom single SKUs can participate.';

-- 兼容：仅精确关键词/标签匹配的高价自定义商品保留 true；不按标题猜测。
UPDATE public.inv_skus s SET fankuang_override = true
 WHERE s.fankuang_override IS NULL AND s.is_custom_price AND s.price_tier > 49.9
   AND (s.keywords && ARRAY['翻筐乐','翻框乐']::text[]
     OR EXISTS (SELECT 1 FROM public.inv_sku_facets sf JOIN public.inv_facets f ON f.id = sf.facet_id
                 WHERE sf.sku_id = s.id AND (f.name IN ('翻筐乐','翻框乐') OR f.aliases && ARRAY['翻筐乐','翻框乐']::text[])));

CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit(p_device_id uuid, p_user_id uuid, p_client_op_id text, p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op public.handheld_smart_create_ops;
  v_op_id uuid;
  v_sku public.inv_skus;
  v_epc text;
  v_bound integer := 0;
  v_qty integer;
BEGIN
  IF p_device_id IS NULL OR p_user_id IS NULL OR p_location_id IS NULL OR coalesce(p_fingerprint,'') = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF p_client_op_id IS NOT NULL THEN
    -- 并发同 op：后到者在唯一索引上等待先到事务提交/回滚
    INSERT INTO public.handheld_smart_create_ops (device_id, client_op_id, user_id, location_id, payload_fingerprint)
    VALUES (p_device_id, p_client_op_id, p_user_id, p_location_id, p_fingerprint)
    ON CONFLICT (device_id, client_op_id) DO NOTHING
    RETURNING id INTO v_op_id;

    IF v_op_id IS NULL THEN
      SELECT * INTO v_op FROM public.handheld_smart_create_ops
        WHERE device_id = p_device_id AND client_op_id = p_client_op_id FOR UPDATE;
      IF v_op.user_id <> p_user_id OR v_op.location_id <> p_location_id
         OR v_op.payload_fingerprint <> p_fingerprint THEN
        RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
      END IF;
      SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_op.sku_id;
      RETURN jsonb_build_object(
        'op_id', v_op.id, 'replayed', true, 'op_status', v_op.status,
        'sku_id', v_op.sku_id, 'sku_code', v_sku.sku_code, 'epc', v_sku.epc,
        'bound_epcs', v_op.bound_epcs, 'stock_qty', v_op.stock_qty,
        'response', v_op.response_json);
    END IF;
  END IF;

  IF p_reuse THEN
    SELECT * INTO v_sku FROM public.inv_skus
      WHERE category = p_sku->>'category'
        AND price_tier = (p_sku->>'price_tier')::numeric
        AND name = p_sku->>'name'
      ORDER BY created_at LIMIT 1 FOR UPDATE;
  END IF;

  IF v_sku.id IS NULL THEN
    INSERT INTO public.inv_skus (
      category, name, price_tier, is_custom_price, inventory_policy, kind, epc, sku_code,
      image_paths, image_url, weight_g, notes, grade, attributes, category_source,
      category_confidence, classification_status, ai_suggested_price, recognition_request_id,
      ip_id, ip_candidate_text, fankuang_override, stock_qty, status)
    VALUES (
      p_sku->>'category', p_sku->>'name', (p_sku->>'price_tier')::numeric,
      coalesce((p_sku->>'is_custom_price')::boolean, false),
      coalesce(p_sku->>'inventory_policy', 'tracked'), 'single', p_sku->>'epc', p_sku->>'sku_code',
      coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_sku->'image_paths','[]'::jsonb))), '{}'),
      p_sku->>'image_url', (p_sku->>'weight_g')::numeric, p_sku->>'notes', p_sku->>'grade',
      coalesce(p_sku->'attributes', '{}'::jsonb), coalesce(p_sku->>'category_source','manual'),
      (p_sku->>'category_confidence')::numeric, coalesce(p_sku->>'classification_status','legacy'),
      (p_sku->>'ai_suggested_price')::numeric, (p_sku->>'recognition_request_id')::uuid,
      (p_sku->>'ip_id')::uuid, p_sku->>'ip_candidate_text',
      CASE WHEN jsonb_typeof(p_sku->'fankuang_override') = 'boolean' THEN (p_sku->>'fankuang_override')::boolean END,
      0, 'active')
    RETURNING * INTO v_sku;
  END IF;

  FOREACH v_epc IN ARRAY coalesce(p_epcs, '{}'::text[]) LOOP
    INSERT INTO public.inv_epcs (epc, sku_id, status, current_location_id, last_seen_at)
    VALUES (v_epc, v_sku.id, 'in_stock', p_location_id, now())
    ON CONFLICT (epc) DO UPDATE SET sku_id = EXCLUDED.sku_id, status = 'in_stock',
      current_location_id = EXCLUDED.current_location_id, last_seen_at = now(), updated_at = now();
    v_bound := v_bound + 1;
  END LOOP;

  v_qty := public.inv_apply_movement(v_sku.id, p_location_id, 1 + v_bound,
    'handheld_smart_create', v_sku.id, v_sku.epc, p_note);

  IF v_op_id IS NOT NULL THEN
    UPDATE public.handheld_smart_create_ops
      SET sku_id = v_sku.id, bound_epcs = v_bound, stock_qty = v_qty
      WHERE id = v_op_id;
  END IF;

  IF p_release_shop_id IS NOT NULL THEN
    INSERT INTO public.handheld_youzan_release_outbox (sku_id, shop_id, location_id, source_op_id)
    VALUES (v_sku.id, p_release_shop_id, p_location_id, v_op_id)
    ON CONFLICT (sku_id, shop_id) DO UPDATE
      SET status = CASE WHEN handheld_youzan_release_outbox.status = 'processing'
                        THEN 'processing' ELSE 'pending' END,
          next_attempt_at = now(), location_id = EXCLUDED.location_id,
          attempts = CASE WHEN handheld_youzan_release_outbox.status = 'processing'
                          THEN handheld_youzan_release_outbox.attempts ELSE 0 END,
          last_error = NULL, updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'op_id', v_op_id, 'replayed', false, 'op_status', 'committed',
    'sku_id', v_sku.id, 'sku_code', v_sku.sku_code, 'epc', v_sku.epc,
    'bound_epcs', v_bound, 'stock_qty', v_qty, 'response', NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.handheld_item_update(p_device_id uuid, p_user_id uuid, p_client_op_id text, p_location_id uuid, p_sku_id uuid, p_expected_updated_at timestamp with time zone, p_patch jsonb, p_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_replay jsonb; v_actor jsonb; v_sku public.inv_skus; v_after public.inv_skus;
  v_key text; v_fields text[] := '{}';
  v_name text; v_price numeric; v_notes text; v_grade text; v_fankuang boolean;
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
    IF v_key NOT IN ('name','price_tier','notes','grade','image_paths','fankuang_override') THEN
      PERFORM public.handheld_item_fail('validation_error', '不允许修改字段 ' || v_key);
    END IF;
  END LOOP;

  v_name := v_sku.name; v_price := v_sku.price_tier; v_notes := v_sku.notes; v_grade := v_sku.grade; v_fankuang := v_sku.fankuang_override;
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

  IF p_patch ? 'fankuang_override' THEN
    IF jsonb_typeof(p_patch->'fankuang_override') NOT IN ('boolean','null') THEN
      PERFORM public.handheld_item_fail('validation_error', '翻筐乐开关必须为 true/false/null');
    END IF;
    v_fankuang := CASE WHEN jsonb_typeof(p_patch->'fankuang_override') = 'null' THEN NULL
                       ELSE (p_patch->>'fankuang_override')::boolean END;
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
  IF v_fankuang IS DISTINCT FROM v_sku.fankuang_override THEN v_fields := v_fields || 'fankuang_override'::text; END IF;

  IF cardinality(v_fields) > 0 THEN
    UPDATE public.inv_skus
       SET name = v_name, price_tier = v_price, notes = v_notes, grade = v_grade, fankuang_override = v_fankuang,
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
$function$;
