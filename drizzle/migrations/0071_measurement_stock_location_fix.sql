-- 0071：尺寸测量门店归属纠错——以 inv_stocks 真实正库存为准（inv_skus 无 location_id，不新增）。
-- 修正 0067–0070 中对不存在的 inv_skus.location_id 的引用；提醒 kind 白名单补 measurement_requested；
-- 顾客通知 ON CONFLICT 对齐实际唯一索引 (customer_id, dedupe_key)；
-- 调拨后活跃任务按 SKU 最终库存（DEFERRABLE INITIALLY DEFERRED constraint trigger）转派/挂起/恢复。
-- 锁顺序：request/save/asset_register 先 inv_skus FOR UPDATE，再普通读 inv_stocks（不锁库存行）；
-- 库存触发器只锁 product_measurement_tasks 与提醒行，不锁 inv_skus，避免与库存写入路径倒序死锁。

ALTER TABLE public.inv_handheld_notifications DROP CONSTRAINT inv_handheld_notifications_kind_check;
ALTER TABLE public.inv_handheld_notifications ADD CONSTRAINT inv_handheld_notifications_kind_check
  CHECK (kind = ANY (ARRAY['stocktake_assigned','transfer_incoming','youzan_sync_failed',
    'unclaimed_epc_pending','system','order_paid','measurement_requested']::text[]));

CREATE OR REPLACE FUNCTION public.measurement_location_has_stock(p_sku_id uuid, p_location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_location_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM inv_stocks WHERE sku_id = p_sku_id AND location_id = p_location_id AND qty > 0)
$$;

CREATE OR REPLACE FUNCTION public.measurement_pick_location(p_sku_id uuid, p_keep uuid, p_listing_location uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int; v_loc uuid;
BEGIN
  IF measurement_location_has_stock(p_sku_id, p_keep) THEN RETURN p_keep; END IF;
  IF measurement_location_has_stock(p_sku_id, p_listing_location) THEN RETURN p_listing_location; END IF;
  SELECT count(*), (array_agg(location_id))[1] INTO v_n, v_loc
    FROM inv_stocks WHERE sku_id = p_sku_id AND qty > 0;
  IF v_n = 1 THEN RETURN v_loc; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.measurement_task_rebalance(p_sku_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task product_measurement_tasks%ROWTYPE;
  v_listing_loc uuid;
  v_new uuid;
  v_n int;
BEGIN
  SELECT * INTO v_task FROM product_measurement_tasks
   WHERE sku_id = p_sku_id AND status IN ('pending','claimed') FOR UPDATE;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  SELECT location_id INTO v_listing_loc FROM commerce_listings WHERE id = v_task.listing_id;
  v_new := measurement_pick_location(p_sku_id, v_task.location_id, v_listing_loc);

  IF v_new IS NULL THEN
    UPDATE product_measurement_tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = now()
     WHERE id = v_task.id AND (status <> 'pending' OR claimed_by IS NOT NULL);
    UPDATE inv_handheld_notifications SET action_status = 'paused'
     WHERE ref_type = 'measurement_task' AND ref_id = v_task.id AND action_status IS NULL;
    RETURN 'paused';
  END IF;

  IF v_new IS DISTINCT FROM v_task.location_id THEN
    UPDATE product_measurement_tasks SET location_id = v_new, status = 'pending',
           claimed_by = NULL, claimed_at = NULL, updated_at = now()
     WHERE id = v_task.id;
    UPDATE inv_handheld_notifications SET location_id = v_new, action_status = NULL, ts = now()
     WHERE ref_type = 'measurement_task' AND ref_id = v_task.id
       AND (action_status IS NULL OR action_status = 'paused');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      INSERT INTO inv_handheld_notifications (kind, title, payload, location_id, ref_type, ref_id)
      SELECT 'measurement_requested', '有顾客申请测量商品尺寸',
             jsonb_build_object('sku_id', s.id, 'listing_id', v_task.listing_id, 'product_name', s.name),
             v_new, 'measurement_task', v_task.id
        FROM inv_skus s WHERE s.id = p_sku_id;
    END IF;
    RETURN 'moved';
  END IF;

  UPDATE inv_handheld_notifications SET action_status = NULL, ts = now()
   WHERE ref_type = 'measurement_task' AND ref_id = v_task.id AND action_status = 'paused';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n > 0 THEN 'resumed' ELSE 'kept' END;
END $$;

CREATE OR REPLACE FUNCTION public.measurement_stock_rebalance_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sku uuid := COALESCE(NEW.sku_id, OLD.sku_id);
BEGIN
  IF EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id = v_sku AND status IN ('pending','claimed')) THEN
    PERFORM measurement_task_rebalance(v_sku);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER measurement_stock_rebalance
  AFTER INSERT OR DELETE OR UPDATE OF qty, location_id ON public.inv_stocks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.measurement_stock_rebalance_trg();

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

CREATE OR REPLACE FUNCTION public.measurement_save(
  p_sku_id uuid, p_task_id uuid, p_actor_id uuid, p_client_op_id text, p_expected_revision integer,
  p_location_id uuid, p_height numeric, p_width numeric, p_depth numeric, p_diameter numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku inv_skus%ROWTYPE;
  v_task product_measurement_tasks%ROWTYPE;
  v_mut measurement_mutations%ROWTYPE;
  v_fingerprint jsonb;
  v_revision integer;
  v_notified integer := 0;
  v_result jsonb;
BEGIN
  IF p_client_op_id IS NULL OR length(p_client_op_id) < 8 THEN
    RAISE EXCEPTION 'client_op_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'expected_revision_required' USING ERRCODE = '22023';
  END IF;
  IF (p_height IS NULL AND p_width IS NULL AND p_depth IS NULL AND p_diameter IS NULL) THEN
    RAISE EXCEPTION 'empty_measurement' USING ERRCODE = '22023';
  END IF;
  IF (p_height IS NOT NULL AND (p_height <= 0 OR p_height > 9999.99))
     OR (p_width IS NOT NULL AND (p_width <= 0 OR p_width > 9999.99))
     OR (p_depth IS NOT NULL AND (p_depth <= 0 OR p_depth > 9999.99))
     OR (p_diameter IS NOT NULL AND (p_diameter <= 0 OR p_diameter > 9999.99)) THEN
    RAISE EXCEPTION 'invalid_measurement' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := jsonb_build_object('sku_id', p_sku_id, 'expected_revision', p_expected_revision,
    'height_cm', p_height, 'width_cm', p_width, 'depth_cm', p_depth, 'diameter_cm', p_diameter);

  SELECT * INTO v_sku FROM inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_mut.fingerprint = v_fingerprint THEN
      RETURN v_mut.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
  END IF;

  IF p_actor_id IS NULL OR NOT (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_actor_id AND role::text IN ('super_admin','hq_operator'))
    OR EXISTS (SELECT 1 FROM user_location_perms WHERE user_id = p_actor_id AND location_id = p_location_id)
  ) THEN
    RAISE EXCEPTION 'unauthorized_role' USING ERRCODE = '42501';
  END IF;
  IF NOT measurement_location_has_stock(p_sku_id, p_location_id) THEN
    RAISE EXCEPTION 'location_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_sku.measurement_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM product_measurement_tasks WHERE id = p_task_id FOR UPDATE;
    IF FOUND AND (v_task.status IN ('completed','cancelled') OR v_task.sku_id <> p_sku_id) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF v_task.id IS NULL THEN
    SELECT * INTO v_task FROM product_measurement_tasks
     WHERE sku_id = p_sku_id AND status IN ('pending','claimed') FOR UPDATE;
  END IF;

  v_revision := v_sku.measurement_revision + 1;
  UPDATE inv_skus SET measurement_height_cm = p_height, measurement_width_cm = p_width,
    measurement_depth_cm = p_depth, measurement_diameter_cm = p_diameter,
    measured_by = p_actor_id, measured_at = now(), measurement_revision = v_revision
  WHERE id = v_sku.id;

  IF v_task.id IS NOT NULL THEN
    UPDATE product_measurement_tasks SET status = 'completed', completed_at = now(),
      completed_by = p_actor_id, client_op_id = p_client_op_id, updated_at = now()
    WHERE id = v_task.id;
    UPDATE inv_handheld_notifications SET action_status = 'handled'
    WHERE ref_type = 'measurement_task' AND ref_id = v_task.id
      AND (action_status IS NULL OR action_status = 'paused');
    WITH pending_requesters AS (
      SELECT customer_id FROM product_measurement_requesters
      WHERE task_id = v_task.id AND notified_at IS NULL
    ), inserted AS (
      INSERT INTO commerce_customer_notifications (customer_id, kind, title, body, dedupe_key, product_id)
      SELECT customer_id, 'measurement_completed', '商品尺寸已测量',
             '您申请测量的商品尺寸已更新，打开商品详情即可查看。',
             'measurement:' || v_task.id::text || ':' || customer_id::text, v_task.listing_id
      FROM pending_requesters
      ON CONFLICT (customer_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
      RETURNING customer_id
    )
    SELECT count(*) INTO v_notified FROM inserted;
    UPDATE product_measurement_requesters SET notified_at = now()
    WHERE task_id = v_task.id AND notified_at IS NULL;
  END IF;

  v_result := jsonb_build_object('revision', v_revision, 'task_id', v_task.id,
                                 'notified', v_notified, 'replayed', false);
  INSERT INTO measurement_mutations
    (actor_id, client_op_id, sku_id, location_id, expected_revision, fingerprint, result)
  VALUES (p_actor_id, p_client_op_id, p_sku_id, p_location_id, p_expected_revision, v_fingerprint, v_result);
  RETURN v_result;
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

  IF NOT (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_actor_id AND role::text IN ('super_admin','hq_operator'))
    OR EXISTS (SELECT 1 FROM user_location_perms WHERE user_id = p_actor_id AND location_id = p_location_id)
  ) THEN
    RAISE EXCEPTION 'unauthorized_role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_mut.fingerprint = v_fp THEN
      RETURN v_mut.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
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

REVOKE ALL ON FUNCTION public.measurement_location_has_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_pick_location(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_task_rebalance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_stock_rebalance_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_request(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, uuid, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_location_has_stock(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_pick_location(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_task_rebalance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_request(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, uuid, numeric, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric) TO service_role;