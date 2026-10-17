-- 0074：测量路由改为单一全局事务锁（替代 0073 的按 SKU advisory 锁），并收紧保存回放的 location 指纹。
-- 0073 问题：deferred trigger 按 DML 行顺序依次取多个 SKU 的 advisory 锁，两个批量库存事务以相反 SKU 顺序
-- 提交时会互等成环（即使库存行完全不冲突、即使无测量任务）。
-- 取舍：门店少，测量路由（顾客申请 + 库存提交时的任务转派检查）接受短事务串行，优先正确性。
-- 锁顺序（全局一把锁 → 不可能在两把路由锁之间成环）：
--   request : inv_skus 行 → routing 锁 → task → 提醒
--   trigger : (库存行，由库存事务自身持有) → routing 锁（事务内可重入，只取一次）→ task → 提醒；不锁 inv_skus/inv_stocks
--   save / asset_register / claim 不取 routing 锁。
-- 不改任何库存值、库存事务或触发器定义（仍为 0071 的 DEFERRABLE INITIALLY DEFERRED constraint trigger）。

CREATE OR REPLACE FUNCTION public.measurement_routing_lock()
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT pg_advisory_xact_lock(771367, 1);
$$;

-- 0073 的 measurement_request 调用此函数；改为委托全局 routing 锁，不再按 SKU 取锁
CREATE OR REPLACE FUNCTION public.measurement_sku_advisory_lock(p_sku_id uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.measurement_routing_lock();
$$;
COMMENT ON FUNCTION public.measurement_sku_advisory_lock(uuid) IS
  'DEPRECATED: delegates to measurement_routing_lock() (single global routing lock); per-SKU keys removed in 0074';

CREATE OR REPLACE FUNCTION public.measurement_stock_rebalance_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sku uuid := COALESCE(NEW.sku_id, OLD.sku_id);
BEGIN
  -- 全局 routing 锁：与未提交的首申请串行；批量库存事务多行也只是同一把锁重入，不会形成多锁环
  PERFORM measurement_routing_lock();
  IF EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id = v_sku AND status IN ('pending','claimed')) THEN
    PERFORM measurement_task_rebalance(v_sku);
  END IF;
  RETURN NULL;
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
    -- 完全原 body：指纹 + 原记录 location 必须一致，异 location 同 op 一律 op_conflict
    IF v_mut.fingerprint = v_fingerprint AND v_mut.location_id IS NOT DISTINCT FROM p_location_id THEN
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

-- 只读回放（完全原 body）：actor + op + 指纹 + 原 location；未传 location 时只核原 task 上下文（不从当前库存推断旧位置）
CREATE OR REPLACE FUNCTION public.measurement_save_replay(
  p_sku_id uuid, p_actor_id uuid, p_client_op_id text, p_expected_revision integer,
  p_height numeric, p_width numeric, p_depth numeric, p_diameter numeric,
  p_location_id uuid, p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mut measurement_mutations%ROWTYPE; v_fp jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_client_op_id IS NULL THEN RETURN NULL; END IF;
  v_fp := jsonb_build_object('sku_id', p_sku_id, 'expected_revision', p_expected_revision,
    'height_cm', p_height, 'width_cm', p_width, 'depth_cm', p_depth, 'diameter_cm', p_diameter);
  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_mut.fingerprint IS DISTINCT FROM v_fp
     OR (p_location_id IS NOT NULL AND v_mut.location_id IS DISTINCT FROM p_location_id)
     OR (p_task_id IS NOT NULL AND (v_mut.result->>'task_id') IS DISTINCT FROM p_task_id::text) THEN
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
  END IF;
  RETURN v_mut.result || jsonb_build_object('replayed', true);
END $$;
COMMENT ON FUNCTION public.measurement_save_replay(uuid, uuid, text, integer, numeric, numeric, numeric, numeric) IS
  'DEPRECATED: no location check; replaced by 10-arg measurement_save_replay (0074)';

REVOKE ALL ON FUNCTION public.measurement_routing_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_sku_advisory_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_stock_rebalance_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, uuid, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.measurement_save_replay(uuid, uuid, text, integer, numeric, numeric, numeric, numeric, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_routing_lock() TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_sku_advisory_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, uuid, numeric, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.measurement_save_replay(uuid, uuid, text, integer, numeric, numeric, numeric, numeric, uuid, uuid) TO service_role;
