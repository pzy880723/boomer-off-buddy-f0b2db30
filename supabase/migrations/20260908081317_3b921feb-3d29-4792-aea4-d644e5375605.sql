-- Customer support context and cross-device read watermarks. Backend access only.
ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS context_key text,
  ADD COLUMN IF NOT EXISTS context jsonb;

-- Legacy conversations remain untouched; only new verified context keys participate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_active_customer_context
  ON public.support_conversations(customer_id, context_key)
  WHERE context_key IS NOT NULL AND status IN ('open', 'pending');

CREATE TABLE IF NOT EXISTS public.support_customer_reads (
  conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, customer_id)
);
ALTER TABLE public.support_customer_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_customer_reads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.support_customer_reads TO service_role;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.support_customer_reads'::regclass
      AND polname = 'support customer reads are backend only'
  ) THEN
    CREATE POLICY "support customer reads are backend only"
      ON public.support_customer_reads FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.support_customer_mark_read(
  p_conversation_id uuid, p_customer_id uuid, p_last_read_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.support_conversations
    WHERE id = p_conversation_id AND customer_id = p_customer_id
  ) THEN RAISE EXCEPTION 'conversation not found'; END IF;
  -- The API passes an actually returned public message's timestamp, never wall-clock now().
  IF NOT EXISTS (
    SELECT 1 FROM public.support_messages
    WHERE conversation_id = p_conversation_id AND internal = false AND created_at = p_last_read_at
  ) THEN RAISE EXCEPTION 'invalid read watermark'; END IF;
  INSERT INTO public.support_customer_reads(conversation_id, customer_id, last_read_at)
  VALUES (p_conversation_id, p_customer_id, p_last_read_at)
  ON CONFLICT (conversation_id, customer_id) DO UPDATE
    SET last_read_at = greatest(support_customer_reads.last_read_at, EXCLUDED.last_read_at);
END;
$$;
REVOKE ALL ON FUNCTION public.support_customer_mark_read(uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_customer_mark_read(uuid,uuid,timestamptz) TO service_role;

-- One round trip per poll. Only the newest 50 owned conversations are expanded;
-- unread counts are exact over all public staff messages, not a bounded message page.
CREATE OR REPLACE FUNCTION public.support_customer_conversation_list(p_customer_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(summary) ORDER BY summary.updated_at DESC, summary.id DESC), '[]'::jsonb)
  FROM (
    SELECT c.id, c.title, c.status, c.location_id, c.order_id, c.context,
      latest.created_at AS last_message_at,
      left(latest.body, 120) AS last_message_preview,
      c.updated_at, unread.total AS unread_count
    FROM (
      SELECT id, title, status, location_id, order_id, context, updated_at
      FROM public.support_conversations
      WHERE customer_id = p_customer_id
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    ) c
    LEFT JOIN public.support_customer_reads r
      ON r.conversation_id = c.id AND r.customer_id = p_customer_id
    LEFT JOIN LATERAL (
      SELECT m.body, m.created_at
      FROM public.support_messages m
      WHERE m.conversation_id = c.id AND m.internal = false
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) latest ON true
    CROSS JOIN LATERAL (
      SELECT count(*) AS total
      FROM public.support_messages m
      WHERE m.conversation_id = c.id AND m.internal = false AND m.sender_type = 'staff'
        AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
    ) unread
  ) summary;
$$;
REVOKE ALL ON FUNCTION public.support_customer_conversation_list(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_customer_conversation_list(uuid) TO service_role;