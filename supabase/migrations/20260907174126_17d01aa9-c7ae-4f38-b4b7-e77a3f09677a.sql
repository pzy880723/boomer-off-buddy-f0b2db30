-- 1) 游标状态：新增 failed（重试用尽）
ALTER TABLE public.youzan_order_sync_cursors DROP CONSTRAINT IF EXISTS youzan_order_sync_cursors_status_check;
ALTER TABLE public.youzan_order_sync_cursors
  ADD CONSTRAINT youzan_order_sync_cursors_status_check
  CHECK (status IN ('pending','running','done','error','failed'));

-- 2) 领取：连续失败 < 8 才重试，done/failed 不再领取
DROP FUNCTION IF EXISTS public.youzan_claim_order_sync_cursor(text, integer);
CREATE OR REPLACE FUNCTION public.youzan_claim_order_sync_cursor(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.youzan_order_sync_cursors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM public.youzan_order_sync_cursors
  WHERE attempts < 8
    AND (
      status IN ('pending','error')
      OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
    )
  ORDER BY window_start ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.youzan_order_sync_cursors
     SET status = 'running',
         lease_owner = p_worker_id,
         lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600))),
         updated_at = now()
   WHERE id = v_id
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.youzan_claim_order_sync_cursor(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_claim_order_sync_cursor(text, integer) TO service_role;

-- 3) 租约 CAS 推进：只有持有租约的 worker 能写回，过期 worker 覆盖不了
CREATE OR REPLACE FUNCTION public.youzan_advance_order_sync_cursor(
  p_cursor_id uuid,
  p_worker_id text,
  p_status text,
  p_next_page integer,
  p_method_label text,
  p_upserted integer,
  p_attempts integer,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_status NOT IN ('pending','done','error','failed') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;

  UPDATE public.youzan_order_sync_cursors
     SET status = p_status,
         next_page = greatest(1, coalesce(p_next_page, next_page)),
         method_label = coalesce(p_method_label, method_label),
         total_upserted = total_upserted + greatest(0, coalesce(p_upserted, 0)),
         attempts = greatest(0, coalesce(p_attempts, attempts)),
         last_error = p_error,
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_progress_at = CASE WHEN p_status IN ('pending','done') THEN now() ELSE last_progress_at END,
         updated_at = now()
   WHERE id = p_cursor_id
     AND lease_owner = p_worker_id
     AND status = 'running'
     AND (lease_expires_at IS NULL OR lease_expires_at > now());

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.youzan_advance_order_sync_cursor(uuid, text, text, integer, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_advance_order_sync_cursor(uuid, text, text, integer, text, integer, integer, text) TO service_role;

-- 4) 角色 + 门店范围 + 审计：单事务原子写入
CREATE OR REPLACE FUNCTION public.set_user_scope_atomic(
  p_actor_id uuid,
  p_actor_role text,
  p_target_user_id uuid,
  p_roles text[],
  p_location_ids uuid[],
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before_roles text[];
  v_after_roles text[];
  v_before_locs uuid[];
  v_after_locs uuid[];
  v_remaining_admins integer;
  v_invalid uuid[];
BEGIN
  IF NOT public.has_role(p_actor_id, 'super_admin') THEN
    RAISE EXCEPTION 'not_super_admin';
  END IF;

  SELECT coalesce(array_agg(DISTINCT role::text ORDER BY role::text), '{}')
    INTO v_before_roles
  FROM public.user_roles WHERE user_id = p_target_user_id;

  SELECT coalesce(array_agg(DISTINCT r ORDER BY r), '{}') INTO v_after_roles
  FROM unnest(coalesce(p_roles, '{}')) AS r;

  SELECT coalesce(array_agg(DISTINCT location_id ORDER BY location_id), '{}')
    INTO v_before_locs
  FROM public.user_location_perms WHERE user_id = p_target_user_id;

  SELECT coalesce(array_agg(DISTINCT l ORDER BY l), '{}') INTO v_after_locs
  FROM unnest(coalesce(p_location_ids, '{}')) AS l;

  -- 自提权 / 自降级
  IF p_actor_id = p_target_user_id THEN
    IF ('super_admin' = ANY(v_after_roles)) AND NOT ('super_admin' = ANY(v_before_roles)) THEN
      RAISE EXCEPTION 'self_escalation';
    END IF;
    IF ('super_admin' = ANY(v_before_roles)) AND NOT ('super_admin' = ANY(v_after_roles)) THEN
      RAISE EXCEPTION 'self_demotion';
    END IF;
  END IF;

  -- 最后一个超级管理员
  IF ('super_admin' = ANY(v_before_roles)) AND NOT ('super_admin' = ANY(v_after_roles)) THEN
    SELECT count(*) INTO v_remaining_admins
    FROM public.user_roles
    WHERE role = 'super_admin' AND user_id <> p_target_user_id;
    IF v_remaining_admins = 0 THEN
      RAISE EXCEPTION 'last_super_admin';
    END IF;
  END IF;

  -- 门店必须真实且启用
  SELECT coalesce(array_agg(l), '{}') INTO v_invalid
  FROM unnest(v_after_locs) AS l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inv_locations loc WHERE loc.id = l AND loc.is_active
  );
  IF array_length(v_invalid, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_locations:%', v_invalid;
  END IF;

  DELETE FROM public.user_roles
   WHERE user_id = p_target_user_id AND role::text <> ALL(v_after_roles);

  INSERT INTO public.user_roles (user_id, role)
  SELECT p_target_user_id, r::app_role FROM unnest(v_after_roles) AS r
  ON CONFLICT (user_id, role) DO NOTHING;

  DELETE FROM public.user_location_perms
   WHERE user_id = p_target_user_id AND location_id <> ALL(v_after_locs);

  INSERT INTO public.user_location_perms (user_id, location_id)
  SELECT p_target_user_id, l FROM unnest(v_after_locs) AS l
  ON CONFLICT (user_id, location_id) DO NOTHING;

  IF v_before_roles IS DISTINCT FROM v_after_roles
     OR v_before_locs IS DISTINCT FROM v_after_locs THEN
    INSERT INTO public.user_scope_audit_logs (
      target_user_id, action, before_snapshot, after_snapshot, reason, actor_id, actor_role
    ) VALUES (
      p_target_user_id,
      'set_scope',
      jsonb_build_object('roles', to_jsonb(v_before_roles), 'location_ids', to_jsonb(v_before_locs)),
      jsonb_build_object('roles', to_jsonb(v_after_roles), 'location_ids', to_jsonb(v_after_locs)),
      p_reason,
      p_actor_id,
      p_actor_role
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'roles', to_jsonb(v_after_roles),
    'location_ids', to_jsonb(v_after_locs),
    'changed', (v_before_roles IS DISTINCT FROM v_after_roles
                OR v_before_locs IS DISTINCT FROM v_after_locs)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_scope_atomic(uuid, text, uuid, text[], uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_scope_atomic(uuid, text, uuid, text[], uuid[], text) TO service_role;