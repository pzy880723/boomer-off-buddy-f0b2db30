-- 0069：尺寸保存幂等记录表 + RPC 重写（锁内幂等/归属/活跃任务）+ 通知分类。
-- 回滚：DROP TABLE public.measurement_mutations；重放 0068 的 measurement_save 与 0067 的 measurement_request；重放 0058 的 handheld_notification_category。

-- 1) 幂等记录表：每次保存（含无任务）原子记录原始结果，按 (actor, op) 唯一
CREATE TABLE public.measurement_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  client_op_id text NOT NULL,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  location_id uuid,
  expected_revision integer NOT NULL,
  fingerprint jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, client_op_id)
);
GRANT ALL ON public.measurement_mutations TO service_role;
ALTER TABLE public.measurement_mutations ENABLE ROW LEVEL SECURITY;

-- 2) 申请：门店归属只用 inv_skus 当前 location_id（不再 COALESCE 旧 listing 归属）
CREATE OR REPLACE FUNCTION public.measurement_request(
  p_listing_id uuid,
  p_customer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing commerce_listings%ROWTYPE;
  v_sku inv_skus%ROWTYPE;
  v_task product_measurement_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_listing FROM commerce_listings WHERE id = p_listing_id;
  IF NOT FOUND OR v_listing.status NOT IN ('published','reserved','sold','archived')
     OR (v_listing.status <> 'published' AND v_listing.published_at IS NULL) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_sku FROM inv_skus WHERE id = v_listing.sku_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_sku.measured_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'completed', 'task_id', NULL, 'requested_at', NULL,
      'measurement', jsonb_build_object(
        'height_cm', v_sku.measurement_height_cm,
        'width_cm', v_sku.measurement_width_cm,
        'depth_cm', v_sku.measurement_depth_cm,
        'diameter_cm', v_sku.measurement_diameter_cm,
        'measured_at', v_sku.measured_at,
        'revision', v_sku.measurement_revision
      )
    );
  END IF;

  SELECT * INTO v_task FROM product_measurement_tasks
   WHERE sku_id = v_sku.id AND status IN ('pending','claimed');

  IF NOT FOUND THEN
    INSERT INTO product_measurement_tasks (sku_id, listing_id, location_id)
    VALUES (v_sku.id, v_listing.id, v_sku.location_id)
    ON CONFLICT (sku_id) WHERE status IN ('pending','claimed') DO NOTHING
    RETURNING * INTO v_task;
    IF NOT FOUND THEN
      SELECT * INTO v_task FROM product_measurement_tasks
       WHERE sku_id = v_sku.id AND status IN ('pending','claimed');
    ELSE
      INSERT INTO inv_handheld_notifications (kind, title, payload, location_id, ref_type, ref_id)
      VALUES (
        'measurement_requested',
        '有顾客申请测量商品尺寸',
        jsonb_build_object('sku_id', v_sku.id, 'listing_id', v_listing.id, 'product_name', v_sku.name),
        v_sku.location_id,
        'measurement_task',
        v_task.id
      );
    END IF;
  END IF;

  INSERT INTO product_measurement_requesters (task_id, customer_id)
  VALUES (v_task.id, p_customer_id)
  ON CONFLICT (task_id, customer_id) DO NOTHING;

  RETURN jsonb_build_object(
    'status', 'pending', 'task_id', v_task.id, 'requested_at', v_task.created_at,
    'measurement', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.measurement_request(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_request(uuid, uuid) TO service_role;

-- 3) 保存：锁内幂等（actor+op 指纹一致回放原结果，不一致 409）；锁内查活跃任务；
--    校验传入 location 与 sku 当前归属一致；通知失败整体回滚。
DROP FUNCTION IF EXISTS public.measurement_save(uuid, uuid, uuid, text, integer, numeric, numeric, numeric, numeric);

CREATE FUNCTION public.measurement_save(
  p_sku_id uuid,
  p_task_id uuid,
  p_actor_id uuid,
  p_client_op_id text,
  p_expected_revision integer,
  p_location_id uuid,
  p_height numeric,
  p_width numeric,
  p_depth numeric,
  p_diameter numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  v_fingerprint := jsonb_build_object(
    'sku_id', p_sku_id,
    'expected_revision', p_expected_revision,
    'height_cm', p_height, 'width_cm', p_width,
    'depth_cm', p_depth, 'diameter_cm', p_diameter
  );

  -- 锁内幂等：同一 actor+op 已有记录则核对指纹
  SELECT * INTO v_sku FROM inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_mut.fingerprint = v_fingerprint THEN
      RETURN v_mut.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
  END IF;

  -- 门店归属：传入 location 必须与 sku 当前归属一致（商品调走后旧店不可再改）
  IF p_location_id IS NULL OR v_sku.location_id IS DISTINCT FROM p_location_id THEN
    RAISE EXCEPTION 'location_mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_sku.measurement_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;

  -- 锁内查当前活跃任务（route 预读可能错过申请与保存交错）
  IF p_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM product_measurement_tasks WHERE id = p_task_id FOR UPDATE;
    IF FOUND AND (v_task.status IN ('completed','cancelled') OR v_task.sku_id <> p_sku_id) THEN
      -- 已结束任务且无幂等记录：视为找不到（重试场景由上面幂等分支处理）
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF NOT FOUND OR v_task.id IS NULL THEN
    SELECT * INTO v_task FROM product_measurement_tasks
     WHERE sku_id = p_sku_id AND status IN ('pending','claimed')
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  END IF;

  v_revision := v_sku.measurement_revision + 1;
  UPDATE inv_skus SET
    measurement_height_cm = p_height,
    measurement_width_cm = p_width,
    measurement_depth_cm = p_depth,
    measurement_diameter_cm = p_diameter,
    measured_by = p_actor_id,
    measured_at = now(),
    measurement_revision = v_revision
  WHERE id = v_sku.id;

  IF v_task.id IS NOT NULL THEN
    UPDATE product_measurement_tasks SET
      status = 'completed', completed_at = now(), completed_by = p_actor_id,
      client_op_id = p_client_op_id, updated_at = now()
    WHERE id = v_task.id;

    UPDATE inv_handheld_notifications SET action_status = 'handled'
    WHERE ref_type = 'measurement_task' AND ref_id = v_task.id AND action_status IS NULL;

    WITH pending_requesters AS (
      SELECT customer_id FROM product_measurement_requesters
      WHERE task_id = v_task.id AND notified_at IS NULL
    ), inserted AS (
      INSERT INTO commerce_customer_notifications
        (customer_id, kind, title, body, dedupe_key, product_id)
      SELECT customer_id, 'measurement_completed', '商品尺寸已测量',
             '您申请测量的商品尺寸已更新，打开商品详情即可查看。',
             'measurement:' || v_task.id::text || ':' || customer_id::text,
             v_task.listing_id
      FROM pending_requesters
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
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
  VALUES
    (p_actor_id, p_client_op_id, p_sku_id, v_sku.location_id, p_expected_revision, v_fingerprint, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, uuid, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, uuid, numeric, numeric, numeric, numeric) TO service_role;

-- 4) 通知分类：measurement_* 归入 internal，出现在未读角标与消息列表
CREATE OR REPLACE FUNCTION public.handheld_notification_category(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH k AS (SELECT translate(lower(coalesce(p_kind,'')), '.-', '__') AS v)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['customer','conversation','support','inquiry']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'customers'
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['order','refund','fulfillment','shipment','shortage','pickup']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'orders'
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['internal','announcement','transfer','stocktake','measurement']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'internal'
    ELSE 'system' END
  FROM k
$$;
REVOKE ALL ON FUNCTION public.handheld_notification_category(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notification_category(text) TO service_role;