CREATE INDEX IF NOT EXISTS idx_support_messages_conv_sender_created
  ON public.support_messages (conversation_id, sender_type, created_at DESC);

-- 列表/详情摘要：一次聚合 unread_count（顾客消息晚于该员工 last_read_at）与最近顾客消息时间
-- p_read_at 非空时按 greatest(last_read_at, p_read_at) 计算，用于详情与已读写入并行时避免返回旧未读。
CREATE OR REPLACE FUNCTION public.support_conversation_stats(
  p_user_id uuid,
  p_conversation_ids uuid[],
  p_read_at timestamptz DEFAULT NULL
) RETURNS TABLE(conversation_id uuid, unread_count bigint, last_customer_message_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH ids AS (
    SELECT DISTINCT unnest(p_conversation_ids) AS id
    LIMIT 200
  ), reads AS (
    SELECT i.id,
      CASE
        WHEN p_read_at IS NULL THEN p.last_read_at
        ELSE greatest(coalesce(p.last_read_at, p_read_at), p_read_at)
      END AS read_at
    FROM ids i
    LEFT JOIN public.support_participants p
      ON p.conversation_id = i.id AND p.user_id = p_user_id
  )
  SELECT r.id,
    (SELECT count(*) FROM public.support_messages m
      WHERE m.conversation_id = r.id AND m.sender_type = 'customer'
        AND (r.read_at IS NULL OR m.created_at > r.read_at)),
    (SELECT max(m.created_at) FROM public.support_messages m
      WHERE m.conversation_id = r.id AND m.sender_type = 'customer')
  FROM reads r;
$$;

-- 已读水位：只单调前移 last_read_at，冲突时不改 participant_role / display_name（不覆盖新权限）
CREATE OR REPLACE FUNCTION public.support_mark_read(
  p_conversation_id uuid,
  p_user_id uuid,
  p_participant_role text,
  p_display_name text,
  p_read_at timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v timestamptz;
BEGIN
  INSERT INTO public.support_participants AS p (conversation_id, user_id, participant_role, display_name, last_read_at)
  VALUES (p_conversation_id, p_user_id, p_participant_role, p_display_name, p_read_at)
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET last_read_at = greatest(coalesce(p.last_read_at, EXCLUDED.last_read_at), EXCLUDED.last_read_at)
  RETURNING last_read_at INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION public.support_conversation_stats(uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_conversation_stats(uuid, uuid[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.support_mark_read(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_mark_read(uuid, uuid, text, text, timestamptz) TO service_role;