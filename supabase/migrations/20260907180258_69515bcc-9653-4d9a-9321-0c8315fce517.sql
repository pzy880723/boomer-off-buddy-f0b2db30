-- 1) ERP → GO 授权镜像同步状态
CREATE TABLE public.go_scope_sync_outbox (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  go_project_ref text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('user_scope','identity_link','shop_link')),
  subject_key text NOT NULL,
  target_user_id uuid,
  change_kind text NOT NULL CHECK (change_kind IN ('grant','revoke','update')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  version bigint NOT NULL DEFAULT 1,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (go_project_ref, subject_type, subject_key)
);

GRANT ALL ON public.go_scope_sync_outbox TO service_role;
ALTER TABLE public.go_scope_sync_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super admins can read go scope sync state"
ON public.go_scope_sync_outbox
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'super_admin'));

GRANT SELECT ON public.go_scope_sync_outbox TO authenticated;

CREATE INDEX go_scope_sync_outbox_status_idx
  ON public.go_scope_sync_outbox (status, next_attempt_at);
CREATE INDEX go_scope_sync_outbox_target_idx
  ON public.go_scope_sync_outbox (target_user_id);

CREATE TRIGGER go_scope_sync_outbox_touch
BEFORE UPDATE ON public.go_scope_sync_outbox
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 2) 登记一条待同步（幂等 upsert，版本号单调递增）
CREATE OR REPLACE FUNCTION public.go_scope_enqueue_sync(
  p_go_project_ref text,
  p_subject_type text,
  p_subject_key text,
  p_change_kind text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_target_user_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.go_scope_sync_outbox AS o (
    go_project_ref, subject_type, subject_key, change_kind, payload,
    target_user_id, status, attempts, last_error, next_attempt_at, synced_at
  ) VALUES (
    p_go_project_ref, p_subject_type, p_subject_key, p_change_kind,
    coalesce(p_payload, '{}'::jsonb), p_target_user_id, 'pending', 0, NULL, now(), NULL
  )
  ON CONFLICT (go_project_ref, subject_type, subject_key) DO UPDATE
    SET change_kind = EXCLUDED.change_kind,
        payload = EXCLUDED.payload,
        target_user_id = coalesce(EXCLUDED.target_user_id, o.target_user_id),
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        next_attempt_at = now(),
        synced_at = NULL,
        version = o.version + 1
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.go_scope_enqueue_sync(text, text, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.go_scope_enqueue_sync(text, text, text, text, jsonb, uuid) TO service_role;

-- 3) 原子范围更新 v2：NULL 表示「本维度保持数据库现值」，避免并发编辑互相覆盖
CREATE OR REPLACE FUNCTION public.set_user_scope_atomic_v2(
  p_actor_id uuid,
  p_actor_role text,
  p_target_user_id uuid,
  p_roles text[] DEFAULT NULL,
  p_location_ids uuid[] DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_go_project_ref text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_before_roles text[];
  v_after_roles text[];
  v_before_locs uuid[];
  v_after_locs uuid[];
  v_remaining_admins integer;
  v_invalid uuid[];
  v_changed boolean;
  v_kind text;
BEGIN
  IF NOT public.has_role(p_actor_id, 'super_admin') THEN
    RAISE EXCEPTION 'not_super_admin';
  END IF;

  -- 目标行加锁，避免两个管理员并发编辑互相覆盖
  PERFORM 1 FROM public.user_roles WHERE user_id = p_target_user_id FOR UPDATE;
  PERFORM 1 FROM public.user_location_perms WHERE user_id = p_target_user_id FOR UPDATE;

  SELECT coalesce(array_agg(DISTINCT role::text ORDER BY role::text), '{}')
    INTO v_before_roles FROM public.user_roles WHERE user_id = p_target_user_id;
  SELECT coalesce(array_agg(DISTINCT location_id ORDER BY location_id), '{}')
    INTO v_before_locs FROM public.user_location_perms WHERE user_id = p_target_user_id;

  IF p_roles IS NULL THEN
    v_after_roles := v_before_roles;
  ELSE
    SELECT coalesce(array_agg(DISTINCT r ORDER BY r), '{}') INTO v_after_roles
    FROM unnest(p_roles) AS r;
  END IF;

  IF p_location_ids IS NULL THEN
    v_after_locs := v_before_locs;
  ELSE
    SELECT coalesce(array_agg(DISTINCT l ORDER BY l), '{}') INTO v_after_locs
    FROM unnest(p_location_ids) AS l;
  END IF;

  IF p_actor_id = p_target_user_id THEN
    IF ('super_admin' = ANY(v_after_roles)) AND NOT ('super_admin' = ANY(v_before_roles)) THEN
      RAISE EXCEPTION 'self_escalation';
    END IF;
    IF ('super_admin' = ANY(v_before_roles)) AND NOT ('super_admin' = ANY(v_after_roles)) THEN
      RAISE EXCEPTION 'self_demotion';
    END IF;
  END IF;

  IF ('super_admin' = ANY(v_before_roles)) AND NOT ('super_admin' = ANY(v_after_roles)) THEN
    SELECT count(*) INTO v_remaining_admins
    FROM public.user_roles WHERE role = 'super_admin' AND user_id <> p_target_user_id;
    IF v_remaining_admins = 0 THEN
      RAISE EXCEPTION 'last_super_admin';
    END IF;
  END IF;

  SELECT coalesce(array_agg(l), '{}') INTO v_invalid
  FROM unnest(v_after_locs) AS l
  WHERE NOT EXISTS (SELECT 1 FROM public.inv_locations loc WHERE loc.id = l AND loc.is_active);
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

  v_changed := (v_before_roles IS DISTINCT FROM v_after_roles
                OR v_before_locs IS DISTINCT FROM v_after_locs);

  IF v_changed THEN
    INSERT INTO public.user_scope_audit_logs (
      target_user_id, action, before_snapshot, after_snapshot, reason, actor_id, actor_role
    ) VALUES (
      p_target_user_id, 'set_scope',
      jsonb_build_object('roles', to_jsonb(v_before_roles), 'location_ids', to_jsonb(v_before_locs)),
      jsonb_build_object('roles', to_jsonb(v_after_roles), 'location_ids', to_jsonb(v_after_locs)),
      p_reason, p_actor_id, p_actor_role
    );

    IF p_go_project_ref IS NOT NULL THEN
      -- 去掉任一角色或任一门店 = 撤销类变更，必须 fail closed
      IF EXISTS (SELECT 1 FROM unnest(v_before_roles) AS r WHERE NOT (r = ANY(v_after_roles)))
         OR EXISTS (SELECT 1 FROM unnest(v_before_locs) AS l WHERE NOT (l = ANY(v_after_locs))) THEN
        v_kind := 'revoke';
      ELSE
        v_kind := 'grant';
      END IF;

      PERFORM public.go_scope_enqueue_sync(
        p_go_project_ref, 'user_scope', p_target_user_id::text, v_kind,
        jsonb_build_object('roles', to_jsonb(v_after_roles), 'location_ids', to_jsonb(v_after_locs)),
        p_target_user_id
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'roles', to_jsonb(v_after_roles),
    'location_ids', to_jsonb(v_after_locs),
    'changed', v_changed,
    'sync_status', CASE WHEN v_changed AND p_go_project_ref IS NOT NULL THEN 'pending' ELSE 'synced' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_user_scope_atomic_v2(uuid, text, uuid, text[], uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_scope_atomic_v2(uuid, text, uuid, text[], uuid[], text, text) TO service_role;