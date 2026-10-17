-- 修复 measurement_save：dedupe_key 唯一索引是部分索引，ON CONFLICT 需带匹配谓词。
CREATE OR REPLACE FUNCTION public.measurement_save(
  p_sku_id uuid,
  p_task_id uuid,
  p_actor_id uuid,
  p_client_op_id text,
  p_expected_revision integer,
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
  v_replay product_measurement_tasks%ROWTYPE;
  v_revision integer;
  v_notified integer := 0;
BEGIN
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

  IF p_client_op_id IS NOT NULL THEN
    SELECT * INTO v_replay FROM product_measurement_tasks
     WHERE client_op_id = p_client_op_id AND status = 'completed';
    IF FOUND THEN
      SELECT measurement_revision INTO v_revision FROM inv_skus WHERE id = v_replay.sku_id;
      RETURN jsonb_build_object('revision', v_revision, 'task_id', v_replay.id,
                                'notified', 0, 'replayed', true);
    END IF;
  END IF;

  SELECT * INTO v_sku FROM inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sku.measurement_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM product_measurement_tasks WHERE id = p_task_id FOR UPDATE;
    IF NOT FOUND OR v_task.status IN ('completed','cancelled') OR v_task.sku_id <> p_sku_id THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
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

  IF p_task_id IS NOT NULL THEN
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

  RETURN jsonb_build_object('revision', v_revision, 'task_id', v_task.id,
                            'notified', v_notified, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_save(uuid, uuid, uuid, text, integer, numeric, numeric, numeric, numeric) TO service_role;