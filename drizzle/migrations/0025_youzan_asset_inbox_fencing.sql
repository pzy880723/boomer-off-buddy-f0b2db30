ALTER TABLE public.youzan_member_asset_inbox ADD COLUMN IF NOT EXISTS claim_token uuid;

DROP FUNCTION IF EXISTS public.youzan_asset_inbox_finish(uuid, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_claim(p_limit int)
RETURNS SETOF public.youzan_member_asset_inbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE youzan_member_asset_inbox t SET status = 'processing', attempts = t.attempts + 1,
    claim_token = gen_random_uuid(), lease_until = now() + interval '5 minutes', updated_at = now()
  WHERE t.id IN (
    SELECT id FROM youzan_member_asset_inbox
     WHERE next_attempt_at <= now()
       AND (status IN ('pending','retry') OR (status = 'processing' AND lease_until < now()))
     ORDER BY next_attempt_at LIMIT greatest(1, least(p_limit, 100))
     FOR UPDATE SKIP LOCKED)
  RETURNING t.*;
END $$;

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_finish(
  p_id uuid, p_claim_token uuid, p_status text, p_reason text, p_next_attempt_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('retry','blocked','dead','pending') THEN
    RAISE EXCEPTION 'invalid inbox finish status %', p_status USING ERRCODE = '22023';
  END IF;
  IF p_claim_token IS NULL THEN RETURN false; END IF;
  UPDATE youzan_member_asset_inbox SET status = p_status, reason = left(p_reason, 200),
    next_attempt_at = coalesce(p_next_attempt_at, now()), lease_until = NULL, claim_token = NULL, updated_at = now()
  WHERE id = p_id AND status = 'processing' AND claim_token = p_claim_token AND lease_until > now();
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_requeue(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE youzan_member_asset_inbox SET status = 'pending', next_attempt_at = now(),
    claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE id = p_id AND status IN ('blocked','dead','processing');
END $$;

REVOKE ALL ON FUNCTION public.youzan_asset_inbox_claim(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_asset_inbox_finish(uuid,uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_asset_inbox_requeue(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_claim(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_finish(uuid,uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_requeue(uuid) TO service_role;