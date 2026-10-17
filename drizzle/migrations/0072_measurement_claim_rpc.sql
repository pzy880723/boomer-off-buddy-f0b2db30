-- 0072：尺寸任务领取事务 RPC。锁 task 行后重查当前 location、actor 权限、该店正库存；
-- 禁止 NULL 门店/HQ 无货绕过；同 actor 已领取幂等但同样重验；返回不含门店信息。
-- 锁顺序与 0071 一致：只锁 task 行（不锁 inv_skus / inv_stocks）。
CREATE OR REPLACE FUNCTION public.measurement_claim(p_task_id uuid, p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task product_measurement_tasks%ROWTYPE;
BEGIN
  IF p_task_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_task FROM product_measurement_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status NOT IN ('pending','claimed') THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_task.location_id IS NULL OR NOT (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_actor_id AND role::text IN ('super_admin','hq_operator'))
    OR EXISTS (SELECT 1 FROM user_location_perms WHERE user_id = p_actor_id AND location_id = v_task.location_id)
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT measurement_location_has_stock(v_task.sku_id, v_task.location_id) THEN
    RAISE EXCEPTION 'no_stock' USING ERRCODE = '42501';
  END IF;
  IF v_task.status = 'claimed' THEN
    IF v_task.claimed_by = p_actor_id THEN
      RETURN jsonb_build_object('task_id', v_task.id, 'status', 'claimed', 'replayed', true);
    END IF;
    RAISE EXCEPTION 'already_claimed' USING ERRCODE = '40001';
  END IF;
  UPDATE product_measurement_tasks SET status = 'claimed', claimed_by = p_actor_id,
         claimed_at = now(), updated_at = now()
   WHERE id = v_task.id;
  RETURN jsonb_build_object('task_id', v_task.id, 'status', 'claimed', 'replayed', false);
END $$;

REVOKE ALL ON FUNCTION public.measurement_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_claim(uuid, uuid) TO service_role;
