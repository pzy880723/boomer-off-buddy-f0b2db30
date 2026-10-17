-- 0073：尺寸测量并发与回放收口（只改测量函数/触发器函数，不改库存值、不改库存事务）。
-- 1) 首申请未提交窗口：measurement_request 在 SKU 行锁后取 SKU 维度 advisory xact 锁；
--    库存 deferred trigger 无条件先取同一 advisory 锁再查活跃任务（READ COMMITTED 下锁后新语句可见已提交任务）。
--    锁顺序：request = inv_skus 行 → advisory → task → 提醒；trigger = (库存行，由库存事务持有) → advisory → task → 提醒；
--    trigger 不锁 inv_skus/inv_stocks；save/asset_register/claim 不取 advisory，不形成环。
-- 2) 已成功 op 回放：measurement_save_replay / measurement_asset_replay 只读查询当前 actor+op 且指纹完全一致的
--    已完成 mutation，命中返回原结果（replayed=true），指纹不同 op_conflict，未命中 NULL（调用方继续全部当前校验）。
--    measurement_asset_register 与 measurement_save 对齐：sku 锁后先 op 回放，再权限/库存/版本。

CREATE OR REPLACE FUNCTION public.measurement_sku_advisory_lock(p_sku_id uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT pg_advisory_xact_lock(771366, hashtext('measurement_sku:' || p_sku_id::text));
$$;

CREATE OR REPLACE FUNCTION public.measurement_stock_rebalance_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sku uuid := COALESCE(NEW.sku_id, OLD.sku_id);
BEGIN
  -- 无条件先取 SKU advisory 锁：若首申请事务未提交，在此等待其提交后再检查活跃任务
  PERFORM measurement_sku_advisory_lock(v_sku);
  IF EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id = v_sku AND status IN ('pending','claimed')) THEN
    PERFORM measurement_task_rebalance(v_sku);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.measurement_request(p_listing_id uuid, p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing commerce_listings%ROWTYPE;
  v_sku inv_skus%ROWTYPE;
  v_task product_measurement_tasks%ROWTYPE;
  v_loc uuid;
  v_state text;
BEGIN
  SELECT * INTO v_listing FROM commerce_listings WHERE id = p_listing_id;
  IF NOT FOUND OR v_listing.status NOT IN ('published','reserved','sold','archived')
     OR (v_listing.status <> 'published' AND v_listing.published_at IS NULL) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_sku FROM inv_skus WHERE id = v_listing.sku_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  -- SKU 维度事务级 advisory 锁：与库存 deferred trigger 串行，确保未提交的首申请提交后才被转派检查
  PERFORM measurement_sku_advisory_lock(v_sku.id);

  IF v_sku.measured_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'completed', 'task_id', NULL, 'requested_at', NULL,
      'measurement', jsonb_build_object(
        'height_cm', v_sku.measurement_height_cm, 'width_cm', v_sku.measurement_width_cm,
        'depth_cm', v_sku.measurement_depth_cm, 'diameter_cm', v_sku.measurement_diameter_cm,
        'measured_at', v_sku.measured_at, 'revision', v_sku.measurement_revision));
  END IF;

  SELECT * INTO v_task FROM product_measurement_tasks
   WHERE sku_id = v_sku.id AND status IN ('pending','claimed') FOR UPDATE;
  IF FOUND THEN
    v_state := measurement_task_rebalance(v_sku.id);
    IF v_state = 'paused' THEN
      RETURN jsonb_build_object('status', 'unavailable', 'task_id', NULL, 'requested_at', NULL,
        'measurement', NULL, 'message', '该商品暂无门店现货，暂时无法安排测量，请联系门店咨询');
    END IF;
  ELSE
    v_loc := measurement_pick_location(v_sku.id, NULL, v_listing.location_id);
    IF v_loc IS NULL THEN
      RETURN jsonb_build_object('status', 'unavailable', 'task_id', NULL, 'requested_at', NULL,
        'measurement', NULL, 'message', '该商品暂无门店现货，暂时无法安排测量，请联系门店咨询');
    END IF;
    INSERT INTO product_measurement_tasks (sku_id, listing_id, location_id)
    VALUES (v_sku.id, v_listing.id, v_loc)
    ON CONFLICT (sku_id) WHERE status IN ('pending','claimed') DO NOTHING
    RETURNING * INTO v_task;
    IF NOT FOUND THEN
      SELECT * INTO v_task FROM product_measurement_tasks
       WHERE sku_id = v_sku.id AND status IN ('pending','claimed');
    ELSE
      INSERT INTO inv_handheld_notifications (kind, title, payload, location_id, ref_type, ref_id)
      VALUES ('measurement_requested', '有顾客申请测量商品尺寸',
        jsonb_build_object('sku_id', v_sku.id, 'listing_id', v_listing.id, 'product_name', v_sku.name),
        v_loc, 'measurement_task', v_task.id);
    END IF;
  END IF;

  INSERT INTO product_measurement_requesters (task_id, customer_id)
  VALUES (v_task.id, p_customer_id) ON CONFLICT (task_id, customer_id) DO NOTHING;

  RETURN jsonb_build_object('status', 'pending', 'task_id', v_task.id,
    'requested_at', v_task.created_at, 'measurement', NULL);
END $$;

CREATE OR REPLACE FUNCTION public.measurement_asset_register(
  p_sku_id uuid, p_actor_id uuid, p_client_op_id text, p_location_id uuid, p_revision integer,
  p_height_cm numeric, p_width_cm numeric, p_content_hash text, p_preview_path text, p_bbox jsonb,
  p_front_width_px integer, p_front_height_px integer, p_px_per_cm numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku inv_skus%ROWTYPE;
  v_mut measurement_mutations%ROWTYPE;
  v_asset product_measurement_assets%ROWTYPE;
  v_fp jsonb;
  v_width numeric;
  v_result jsonb;
BEGIN
  IF p_client_op_id IS NULL OR length(p_client_op_id) < 8 OR length(p_client_op_id) > 128 THEN
    RAISE EXCEPTION 'client_op_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL OR p_location_id IS NULL OR p_revision IS NULL OR p_revision < 1 THEN
    RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[0-9a-f]{16}$'
     OR p_preview_path IS DISTINCT FROM
        ('sku-listing/measurements/' || p_sku_id::text || '/' || p_revision::text || '-' || p_content_hash || '-640.png')
     OR p_bbox IS NULL OR p_front_width_px IS NULL OR p_front_width_px <= 0
     OR p_front_height_px IS NULL OR p_front_height_px <= 0
     OR p_px_per_cm IS NULL OR p_px_per_cm <= 0
     OR p_height_cm IS NULL OR p_height_cm <= 0 OR p_width_cm IS NULL OR p_width_cm <= 0 THEN
    RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023';
  END IF;

  v_fp := jsonb_build_object('kind', 'measurement_image', 'sku_id', p_sku_id, 'revision', p_revision,
    'content_hash', p_content_hash, 'location_id', p_location_id);

  SELECT * INTO v_sku FROM inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_mut.fingerprint = v_fp THEN
      RETURN v_mut.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_actor_id AND role::text IN ('super_admin','hq_operator'))
    OR EXISTS (SELECT 1 FROM user_location_perms WHERE user_id = p_actor_id AND location_id = p_location_id)
  ) THEN
    RAISE EXCEPTION 'unauthorized_role' USING ERRCODE = '42501';
  END IF;

  IF NOT measurement_location_has_stock(p_sku_id, p_location_id) THEN
    RAISE EXCEPTION 'location_mismatch' USING ERRCODE = '42501';
  END IF;

  v_width := COALESCE(v_sku.measurement_width_cm, v_sku.measurement_diameter_cm);
  IF v_sku.measured_at IS NULL OR v_sku.measurement_revision <> p_revision
     OR v_sku.measurement_height_cm IS DISTINCT FROM p_height_cm
     OR v_width IS DISTINCT FROM p_width_cm THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_asset FROM product_measurement_assets
   WHERE sku_id = p_sku_id AND revision = p_revision FOR UPDATE;
  IF FOUND AND v_asset.status = 'ready' AND v_asset.cutout_preview_path IS DISTINCT FROM p_preview_path THEN
    RAISE EXCEPTION 'image_conflict' USING ERRCODE = '40001';
  END IF;

  INSERT INTO product_measurement_assets
    (sku_id, revision, status, cutout_preview_path, bbox, front_width_px, front_height_px,
     px_per_cm, error, verified, width_cm, height_cm, updated_at)
  VALUES (p_sku_id, p_revision, 'ready', p_preview_path, p_bbox, p_front_width_px, p_front_height_px,
     p_px_per_cm, NULL, true, p_width_cm, p_height_cm, now())
  ON CONFLICT (sku_id, revision) DO UPDATE SET
    status = 'ready', cutout_preview_path = EXCLUDED.cutout_preview_path, bbox = EXCLUDED.bbox,
    front_width_px = EXCLUDED.front_width_px, front_height_px = EXCLUDED.front_height_px,
    px_per_cm = EXCLUDED.px_per_cm, error = NULL, verified = true,
    width_cm = EXCLUDED.width_cm, height_cm = EXCLUDED.height_cm, updated_at = now();

  v_result := jsonb_build_object('status', 'ready', 'revision', p_revision, 'location_id', p_location_id,
    'cutout_preview_path', p_preview_path, 'width_cm', p_width_cm, 'height_cm', p_height_cm, 'replayed', false);
  INSERT INTO measurement_mutations
    (actor_id, client_op_id, sku_id, location_id, expected_revision, fingerprint, result)
  VALUES (p_actor_id, p_client_op_id, p_sku_id, p_location_id, p_revision, v_fp, v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.measurement_save_replay(
  p_sku_id uuid, p_actor_id uuid, p_client_op_id text, p_expected_revision integer,
  p_height numeric, p_width numeric, p_depth numeric, p_diameter numeric)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mut measurement_mutations%ROWTYPE; v_fp jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_client_op_id IS NULL THEN RETURN NULL; END IF;
  v_fp := jsonb_build_object('sku_id', p_sku_id, 'expected_revision', p_expected_revision,
    'height_cm', p_height, 'width_cm', p_width, 'depth_cm', p_depth, 'diameter_cm', p_diameter);
  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_mut.fingerprint = v_fp THEN RETURN v_mut.result || jsonb_build_object('replayed', true); END IF;
  RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
END $$;

CREATE OR REPLACE FUNCTION public.measurement_asset_replay(
  p_sku_id uuid, p_actor_id uuid, p_client_op_id text, p_location_id uuid, p_revision integer,
  p_content_hash text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mut measurement_mutations%ROWTYPE; v_fp jsonb; v_asset product_measurement_assets%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_client_op_id IS NULL THEN RETURN NULL; END IF;
  v_fp := jsonb_build_object('kind', 'measurement_image', 'sku_id', p_sku_id, 'revision', p_revision,
    'content_hash', p_content_hash, 'location_id', p_location_id);
  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_mut.fingerprint IS DISTINCT FROM v_fp THEN
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_asset FROM product_measurement_assets
   WHERE sku_id = p_sku_id AND revision = p_revision
     AND cutout_preview_path = v_mut.result->>'cutout_preview_path';
  RETURN v_mut.result || jsonb_build_object('replayed', true,
    'bbox', v_asset.bbox, 'front_width_px', v_asset.front_width_px,
    'front_height_px', v_asset.front_height_px, 'px_per_cm', v_asset.px_per_cm);
END $$;

REVOKE ALL ON FUNCTION public.measurement_sku_advisory_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_stock_rebalance_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_request(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_save_replay(uuid, uuid, text, integer, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_asset_replay(uuid, uuid, text, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_sku_advisory_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_request(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_save_replay(uuid, uuid, text, integer, numeric, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_asset_replay(uuid, uuid, text, uuid, integer, text) TO service_role;
