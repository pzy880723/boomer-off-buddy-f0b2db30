-- 客服 M1：主接待人 / 版本锁 / 等待计时 / 总部升级。兼容旧数据：全部新增列可空或带默认。
ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS primary_agent_id uuid,
  ADD COLUMN IF NOT EXISTS assignment_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_reason text,
  ADD COLUMN IF NOT EXISTS waiting_since timestamptz;

ALTER TABLE public.support_conversations
  ADD CONSTRAINT support_conversations_channel_check CHECK (channel IN ('native','wechat_kf')),
  ADD CONSTRAINT support_conversations_escalation_reason_check
    CHECK (escalation_reason IS NULL OR escalation_reason IN ('unclaimed_timeout','reply_timeout'));

ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS assignment_version integer;
ALTER TABLE public.support_messages
  ADD CONSTRAINT support_messages_delivery_status_check CHECK (delivery_status IN ('sent','pending','failed'));

CREATE INDEX IF NOT EXISTS idx_support_conversations_waiting
  ON public.support_conversations (waiting_since)
  WHERE waiting_since IS NOT NULL AND escalated_at IS NULL AND status IN ('open','pending');

-- 等待计时：客户首次等待开始计时，连发不重置；主接待人有效对外回复才清零（并解除升级标记）。
CREATE OR REPLACE FUNCTION public.tg_support_waiting()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE public.support_conversations
       SET waiting_since = coalesce(waiting_since, NEW.created_at)
     WHERE id = NEW.conversation_id AND status <> 'closed';
  ELSIF NEW.sender_type = 'staff' AND NEW.internal = false AND NEW.delivery_status = 'sent' THEN
    UPDATE public.support_conversations
       SET waiting_since = NULL, escalated_at = NULL, escalation_reason = NULL
     WHERE id = NEW.conversation_id AND primary_agent_id = NEW.sender_user_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_support_waiting ON public.support_messages;
CREATE TRIGGER trg_support_waiting AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_support_waiting();

-- 授权：服务端由 user_roles / support_agents / user_location_perms 推导，绝不信任调用方传入的门店。
CREATE OR REPLACE FUNCTION public.support_actor_can_access(p_actor uuid, p_location_id uuid, p_require_hq boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('super_admin','hq_operator'))
      OR EXISTS (SELECT 1 FROM public.support_agents WHERE user_id = p_actor AND is_active AND scope = 'hq')
      OR (NOT p_require_hq AND p_location_id IS NOT NULL AND (
            EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor AND location_id = p_location_id)
         OR EXISTS (SELECT 1 FROM public.support_agents WHERE user_id = p_actor AND is_active AND scope = 'location' AND location_id = p_location_id)));
$$;

-- 领取 / 总部接管 / 关闭 / 重开：同一行锁 + 版本比对，冲突返回 version_conflict。
CREATE OR REPLACE FUNCTION public.support_update_assignment(
  p_conversation_id uuid, p_actor uuid, p_action text, p_expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c public.support_conversations%ROWTYPE;
BEGIN
  IF p_action NOT IN ('claim','takeover','close','reopen') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_action');
  END IF;
  SELECT * INTO c FROM public.support_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF NOT public.support_actor_can_access(p_actor, c.location_id, p_action = 'takeover') THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN p_action = 'takeover' AND public.support_actor_can_access(p_actor, c.location_id) THEN 'hq_only' ELSE 'forbidden' END);
  END IF;
  IF p_expected_version IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'assignment_version_required', 'assignment_version', c.assignment_version);
  END IF;
  IF c.assignment_version <> p_expected_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'version_conflict', 'assignment_version', c.assignment_version, 'primary_agent_id', c.primary_agent_id);
  END IF;
  IF p_action = 'claim' THEN
    IF c.status = 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'conversation_closed'); END IF;
    IF c.primary_agent_id = p_actor THEN
      RETURN jsonb_build_object('ok', true, 'code', 'already_primary', 'assignment_version', c.assignment_version, 'primary_agent_id', c.primary_agent_id, 'status', c.status);
    END IF;
    IF c.primary_agent_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_claimed', 'assignment_version', c.assignment_version, 'primary_agent_id', c.primary_agent_id);
    END IF;
    UPDATE public.support_conversations SET primary_agent_id = p_actor, assignment_version = assignment_version + 1
     WHERE id = c.id RETURNING * INTO c;
  ELSIF p_action = 'takeover' THEN
    IF c.status = 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'conversation_closed'); END IF;
    UPDATE public.support_conversations SET primary_agent_id = p_actor, assignment_version = assignment_version + 1
     WHERE id = c.id RETURNING * INTO c;
  ELSIF p_action = 'close' THEN
    IF c.status = 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'conversation_closed'); END IF;
    UPDATE public.support_conversations
       SET status = 'closed', waiting_since = NULL, escalated_at = NULL, escalation_reason = NULL,
           assignment_version = assignment_version + 1
     WHERE id = c.id RETURNING * INTO c;
  ELSE
    IF c.status <> 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'conversation_not_closed'); END IF;
    UPDATE public.support_conversations SET status = 'open', assignment_version = assignment_version + 1
     WHERE id = c.id RETURNING * INTO c;
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'ok', 'assignment_version', c.assignment_version,
    'primary_agent_id', c.primary_agent_id, 'status', c.status);
END; $$;

-- 员工发消息：锁行 → 授权 → 幂等回放 → 对外消息校验主接待人与版本 → insert，全部同一事务。
CREATE OR REPLACE FUNCTION public.support_staff_post_message(
  p_conversation_id uuid, p_actor uuid, p_actor_name text, p_participant_role text,
  p_body text, p_internal boolean, p_client_op_id text, p_expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c public.support_conversations%ROWTYPE; m public.support_messages%ROWTYPE;
BEGIN
  IF p_body IS NULL OR length(btrim(p_body)) = 0 OR length(p_body) > 4000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_body');
  END IF;
  IF p_client_op_id IS NULL OR length(btrim(p_client_op_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'client_op_id_required');
  END IF;
  SELECT * INTO c FROM public.support_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF NOT public.support_actor_can_access(p_actor, c.location_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  SELECT * INTO m FROM public.support_messages WHERE conversation_id = c.id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF m.sender_user_id IS DISTINCT FROM p_actor THEN RETURN jsonb_build_object('ok', false, 'code', 'client_op_id_conflict'); END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'message', to_jsonb(m) - 'sender_customer_id');
  END IF;
  IF NOT p_internal THEN
    IF c.status = 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'conversation_closed'); END IF;
    IF p_expected_version IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'assignment_version_required', 'assignment_version', c.assignment_version);
    END IF;
    IF c.assignment_version <> p_expected_version THEN
      RETURN jsonb_build_object('ok', false, 'code', 'version_conflict', 'assignment_version', c.assignment_version, 'primary_agent_id', c.primary_agent_id);
    END IF;
    IF c.primary_agent_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'claim_required', 'assignment_version', c.assignment_version); END IF;
    IF c.primary_agent_id <> p_actor THEN RETURN jsonb_build_object('ok', false, 'code', 'not_primary_agent', 'assignment_version', c.assignment_version, 'primary_agent_id', c.primary_agent_id); END IF;
  END IF;
  INSERT INTO public.support_participants (conversation_id, user_id, participant_role, display_name, last_read_at)
  VALUES (c.id, p_actor, CASE WHEN p_participant_role = 'hq_agent' THEN 'hq_agent' ELSE 'store_staff' END, p_actor_name, now())
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = now();
  INSERT INTO public.support_messages (conversation_id, sender_type, sender_user_id, sender_name, body, internal,
      client_op_id, delivery_status, assignment_version)
  VALUES (c.id, 'staff', p_actor, coalesce(nullif(btrim(p_actor_name), ''), '客服'), p_body, p_internal, p_client_op_id,
      CASE WHEN NOT p_internal AND c.channel = 'wechat_kf' THEN 'pending' ELSE 'sent' END, c.assignment_version)
  RETURNING * INTO m;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'message', to_jsonb(m) - 'sender_customer_id');
END; $$;

-- 超时升级（幂等）：未领取 >= p_unclaimed_seconds 或已领取未有效回复 >= p_reply_seconds，按数据库时间判断。
CREATE OR REPLACE FUNCTION public.support_escalate_overdue(p_unclaimed_seconds integer DEFAULT 60, p_reply_seconds integer DEFAULT 180)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE ids uuid[];
BEGIN
  IF p_unclaimed_seconds < 1 OR p_reply_seconds < 1 THEN RAISE EXCEPTION 'invalid_threshold'; END IF;
  WITH due AS (
    SELECT id, CASE WHEN primary_agent_id IS NULL THEN 'unclaimed_timeout' ELSE 'reply_timeout' END AS reason
      FROM public.support_conversations
     WHERE status IN ('open','pending') AND escalated_at IS NULL AND waiting_since IS NOT NULL
       AND ((primary_agent_id IS NULL AND waiting_since <= now() - make_interval(secs => p_unclaimed_seconds))
         OR (primary_agent_id IS NOT NULL AND waiting_since <= now() - make_interval(secs => p_reply_seconds)))
     FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.support_conversations s SET escalated_at = now(), escalation_reason = due.reason
      FROM due WHERE s.id = due.id RETURNING s.id
  ) SELECT coalesce(array_agg(id), '{}') INTO ids FROM upd;
  RETURN jsonb_build_object('escalated', cardinality(ids), 'conversation_ids', to_jsonb(ids), 'checked_at', now());
END; $$;

REVOKE ALL ON FUNCTION public.tg_support_waiting() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_actor_can_access(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_update_assignment(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_staff_post_message(uuid, uuid, text, text, text, boolean, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_escalate_overdue(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_actor_can_access(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.support_update_assignment(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.support_staff_post_message(uuid, uuid, text, text, text, boolean, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.support_escalate_overdue(integer, integer) TO service_role;
