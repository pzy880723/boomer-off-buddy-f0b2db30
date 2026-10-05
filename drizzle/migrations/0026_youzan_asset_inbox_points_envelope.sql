ALTER TABLE public.youzan_member_asset_inbox
  ADD COLUMN IF NOT EXISTS biz_id text,
  ADD COLUMN IF NOT EXISTS msg_version numeric(20,0),
  ADD COLUMN IF NOT EXISTS envelope jsonb,
  ADD COLUMN IF NOT EXISTS redelivery_count int NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.youzan_member_asset_inbox.event_id IS 'Message uniqueness id (POINTS: msg.unique_id). Never the outer business id.';
COMMENT ON COLUMN public.youzan_member_asset_inbox.biz_id IS 'Outer business id (e.g. yuser_xxx); repeats per customer, not unique.';
COMMENT ON COLUMN public.youzan_member_asset_inbox.msg_version IS 'Outer version for ordering (higher overrides lower).';

DROP FUNCTION IF EXISTS public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb);

CREATE FUNCTION public.youzan_asset_inbox_ingest(
  p_kdt_id bigint, p_event_id text, p_msg_type text, p_payload_hash text, p_payload jsonb,
  p_biz_id text DEFAULT NULL, p_msg_version text DEFAULT NULL, p_envelope jsonb DEFAULT NULL,
  p_initial_status text DEFAULT 'pending', p_initial_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_hash text;
BEGIN
  IF p_initial_status NOT IN ('pending','blocked') THEN
    RAISE EXCEPTION 'invalid initial status %', p_initial_status USING ERRCODE = '22023';
  END IF;
  IF p_msg_version IS NOT NULL AND p_msg_version !~ '^[0-9]{1,19}$' THEN
    RAISE EXCEPTION 'invalid msg_version' USING ERRCODE = '22023';
  END IF;
  INSERT INTO youzan_member_asset_inbox
    (kdt_id, event_id, msg_type, payload_hash, payload, biz_id, msg_version, envelope, status, reason)
  VALUES (p_kdt_id, p_event_id, p_msg_type, p_payload_hash, p_payload, p_biz_id,
    p_msg_version::numeric, p_envelope, p_initial_status, left(p_initial_reason, 200))
  ON CONFLICT (kdt_id, event_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('result','accepted','id',v_id); END IF;
  SELECT id, payload_hash INTO v_id, v_hash FROM youzan_member_asset_inbox
   WHERE kdt_id = p_kdt_id AND event_id = p_event_id FOR UPDATE;
  IF v_hash = p_payload_hash THEN
    UPDATE youzan_member_asset_inbox SET redelivery_count = redelivery_count + 1, updated_at = now() WHERE id = v_id;
    RETURN jsonb_build_object('result','duplicate','id',v_id);
  END IF;
  UPDATE youzan_member_asset_inbox SET conflict_count = conflict_count + 1,
    last_conflict_hash = p_payload_hash, last_conflict_at = now(), updated_at = now()
   WHERE id = v_id;
  RETURN jsonb_build_object('result','conflict','id',v_id);
END $$;

REVOKE ALL ON FUNCTION public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb,text,text,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb,text,text,jsonb,text,text) TO service_role;