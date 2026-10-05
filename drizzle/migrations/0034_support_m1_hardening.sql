-- 客服 M1 补丁：微信未接入拒绝对外发送、关闭/重开限主接待人或总部、幂等载荷校验、顾客发送行锁、公开消息聚合。
-- 增量迁移，不修改已应用的 0033；历史 pending 消息保留不补发。

-- 会话聚合：内部备注 / 非 sent 消息不改动顾客可见预览；旧 created_at 不覆盖更新的预览。
CREATE OR REPLACE FUNCTION public.tg_support_conversation_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.internal OR NEW.delivery_status <> 'sent' THEN
    UPDATE public.support_conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  ELSE
    UPDATE public.support_conversations
       SET last_message_preview = CASE WHEN last_message_at IS NULL OR NEW.created_at >= last_message_at
                                       THEN left(NEW.body, 120) ELSE last_message_preview END,
           last_message_at = greatest(coalesce(last_message_at, NEW.created_at), NEW.created_at),
           updated_at = now()
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_support_conversation_touch ON public.support_messages;
CREATE TRIGGER trg_support_conversation_touch AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_support_conversation_touch();

CREATE OR REPLACE FUNCTION public.support_actor_is_hq(p_actor uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('super_admin','hq_operator'))
      OR EXISTS (SELECT 1 FROM public.support_agents WHERE user_id = p_actor AND is_active AND scope = 'hq');
$$;

CREATE OR REPLACE FUNCTION public.support_update_assignment(
  p_conversation_id uuid, p_actor uuid, p_action text, p_expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c public.support_conversations%ROWTYPE; v_hq boolean;
BEGIN
  IF p_action NOT IN ('claim','takeover','close','reopen') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_action');
  END IF;
  SELECT * INTO c FROM public.support_conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF NOT public.support_actor_can_access(p_actor, c.location_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  v_hq := public.support_actor_is_hq(p_actor);
  IF p_action = 'takeover' AND NOT v_hq THEN RETURN jsonb_build_object('ok', false, 'code', 'hq_only'); END IF;
  -- 关闭 / 重开：只允许主接待人或总部；未领取时仅总部
  IF p_action IN ('close','reopen') AND NOT v_hq AND c.primary_agent_id IS DISTINCT FROM p_actor THEN
    RETURN jsonb_build_object('ok', false, 'code', 'primary_or_hq_only');
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
    IF m.sender_type <> 'staff' OR m.sender_user_id IS DISTINCT FROM p_actor
       OR m.body IS DISTINCT FROM p_body OR m.internal IS DISTINCT FROM p_internal THEN
      RETURN jsonb_build_object('ok', false, 'code', 'client_op_id_conflict');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'message', to_jsonb(m) - 'sender_customer_id');
  END IF;
  IF NOT p_internal THEN
    -- 微信客服外发 worker 未接入：拒绝对外发送，避免 pending 假承诺
    IF c.channel <> 'native' THEN RETURN jsonb_build_object('ok', false, 'code', 'channel_not_connected'); END IF;
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
      'sent', c.assignment_version)
  RETURNING * INTO m;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'message', to_jsonb(m) - 'sender_customer_id');
END; $$;

-- 顾客发送：与关闭竞争时同一行锁，关闭后不可插入；同 op 不同载荷冲突。
CREATE OR REPLACE FUNCTION public.support_customer_post_message(
  p_conversation_id uuid, p_customer_id uuid, p_customer_name text, p_body text, p_client_op_id text)
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
  IF NOT FOUND OR c.customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  SELECT * INTO m FROM public.support_messages WHERE conversation_id = c.id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF m.sender_type <> 'customer' OR m.sender_customer_id IS DISTINCT FROM p_customer_id OR m.body IS DISTINCT FROM p_body THEN
      RETURN jsonb_build_object('ok', false, 'code', 'client_op_id_conflict');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'message', to_jsonb(m) - 'sender_user_id' - 'sender_customer_id');
  END IF;
  IF c.status = 'closed' THEN RETURN jsonb_build_object('ok', false, 'code', 'conversation_closed'); END IF;
  INSERT INTO public.support_messages (conversation_id, sender_type, sender_customer_id, sender_name, body, internal, client_op_id)
  VALUES (c.id, 'customer', p_customer_id, coalesce(nullif(btrim(p_customer_name), ''), '顾客'), p_body, false, p_client_op_id)
  RETURNING * INTO m;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'message', to_jsonb(m) - 'sender_user_id' - 'sender_customer_id');
END; $$;

REVOKE ALL ON FUNCTION public.tg_support_conversation_touch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_actor_is_hq(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_update_assignment(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_staff_post_message(uuid, uuid, text, text, text, boolean, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.support_customer_post_message(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_actor_is_hq(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.support_update_assignment(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.support_staff_post_message(uuid, uuid, text, text, text, boolean, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.support_customer_post_message(uuid, uuid, text, text, text) TO service_role;
