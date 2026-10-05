CREATE TABLE public.youzan_member_asset_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kdt_id bigint NOT NULL,
  event_id text NOT NULL,
  msg_type text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry','blocked','dead')),
  reason text,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  conflict_count int NOT NULL DEFAULT 0,
  last_conflict_hash text,
  last_conflict_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kdt_id, event_id)
);
COMMENT ON TABLE public.youzan_member_asset_inbox IS
  'Youzan points/coupon message inbox. No success status by design until asset adapters are approved.';
CREATE INDEX youzan_member_asset_inbox_due_idx
  ON public.youzan_member_asset_inbox (next_attempt_at) WHERE status IN ('pending','retry','processing');

REVOKE ALL ON public.youzan_member_asset_inbox FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.youzan_member_asset_inbox TO authenticated;
GRANT ALL ON public.youzan_member_asset_inbox TO service_role;
ALTER TABLE public.youzan_member_asset_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY youzan_member_asset_inbox_hq_read ON public.youzan_member_asset_inbox
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'hq_operator'));

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_ingest(
  p_kdt_id bigint, p_event_id text, p_msg_type text, p_payload_hash text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_hash text;
BEGIN
  INSERT INTO youzan_member_asset_inbox (kdt_id, event_id, msg_type, payload_hash, payload)
  VALUES (p_kdt_id, p_event_id, p_msg_type, p_payload_hash, p_payload)
  ON CONFLICT (kdt_id, event_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('result','accepted','id',v_id); END IF;
  SELECT id, payload_hash INTO v_id, v_hash FROM youzan_member_asset_inbox
   WHERE kdt_id = p_kdt_id AND event_id = p_event_id FOR UPDATE;
  IF v_hash = p_payload_hash THEN RETURN jsonb_build_object('result','duplicate','id',v_id); END IF;
  UPDATE youzan_member_asset_inbox SET conflict_count = conflict_count + 1,
    last_conflict_hash = p_payload_hash, last_conflict_at = now(), updated_at = now()
   WHERE id = v_id;
  RETURN jsonb_build_object('result','conflict','id',v_id);
END $$;

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_claim(p_limit int)
RETURNS SETOF public.youzan_member_asset_inbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE youzan_member_asset_inbox t SET status = 'processing', attempts = t.attempts + 1,
    lease_until = now() + interval '5 minutes', updated_at = now()
  WHERE t.id IN (
    SELECT id FROM youzan_member_asset_inbox
     WHERE next_attempt_at <= now()
       AND (status IN ('pending','retry') OR (status = 'processing' AND lease_until < now()))
     ORDER BY next_attempt_at LIMIT greatest(1, least(p_limit, 100))
     FOR UPDATE SKIP LOCKED)
  RETURNING t.*;
END $$;

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_finish(
  p_id uuid, p_status text, p_reason text, p_next_attempt_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('retry','blocked','dead','pending') THEN
    RAISE EXCEPTION 'invalid inbox finish status %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE youzan_member_asset_inbox SET status = p_status, reason = left(p_reason, 200),
    next_attempt_at = coalesce(p_next_attempt_at, now()), lease_until = NULL, updated_at = now()
  WHERE id = p_id AND status = 'processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'inbox row % not processing', p_id USING ERRCODE = '55000'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_requeue(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE youzan_member_asset_inbox SET status = 'pending', next_attempt_at = now(), updated_at = now()
   WHERE id = p_id AND status IN ('blocked','dead');
END $$;

REVOKE ALL ON FUNCTION public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_asset_inbox_claim(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_asset_inbox_finish(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_asset_inbox_requeue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_claim(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_finish(uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_requeue(uuid) TO service_role;