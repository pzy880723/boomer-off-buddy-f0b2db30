-- Async POS payment: durable client_op_id binding + recover/cancel tombstone.
-- Plain-text payment codes are never stored (only the existing sha256 hash / last4 columns).
ALTER TABLE public.pos_payment_attempts ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.pos_payment_attempts ADD CONSTRAINT pos_payment_attempts_request_fingerprint_check
  CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$');

CREATE TABLE public.pos_payment_op_tombstones (
  client_op_id text PRIMARY KEY,
  location_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  cancelled_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.pos_payment_op_tombstones FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pos_payment_op_tombstones TO service_role;
ALTER TABLE public.pos_payment_op_tombstones ENABLE ROW LEVEL SECURITY;

-- Create-or-replay under one per-op advisory lock shared with recover/cancel.
CREATE OR REPLACE FUNCTION public.pos_payment_attempt_reserve(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_op text := p->>'client_op_id';
  v_row public.pos_payment_attempts%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_op IS NULL OR length(v_op) < 8 OR coalesce(p->>'request_fingerprint','') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-pay-op:' || v_op, 0));
  IF EXISTS (SELECT 1 FROM public.pos_payment_op_tombstones WHERE client_op_id = v_op) THEN
    RETURN jsonb_build_object('state', 'cancelled');
  END IF;
  SELECT * INTO v_row FROM public.pos_payment_attempts WHERE client_op_id = v_op;
  IF FOUND THEN
    IF v_row.location_id <> (p->>'location_id')::uuid OR v_row.shift_id <> (p->>'shift_id')::uuid
       OR v_row.operator_id <> (p->>'operator_id')::uuid OR v_row.provider <> p->>'provider' OR v_row.mode <> p->>'mode'
       OR v_row.request_fingerprint IS DISTINCT FROM p->>'request_fingerprint' THEN
      RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
    END IF;
    RETURN jsonb_build_object('state', 'existing', 'id', v_row.id);
  END IF;
  INSERT INTO public.pos_payment_attempts (location_id, shift_id, operator_id, payment_profile_id, settlement_subject_id,
    provider, mode, out_trade_no, amount, currency, status, client_op_id, customer_id, auth_code_hash, auth_code_last4,
    expires_at, sale_payload, provider_response, request_fingerprint)
  VALUES ((p->>'location_id')::uuid, (p->>'shift_id')::uuid, (p->>'operator_id')::uuid,
    (p->>'payment_profile_id')::uuid, (p->>'settlement_subject_id')::uuid, p->>'provider', p->>'mode', p->>'out_trade_no',
    (p->>'amount')::numeric, 'CNY', 'pending', v_op, nullif(p->>'customer_id','')::uuid, p->>'auth_code_hash',
    p->>'auth_code_last4', nullif(p->>'expires_at','')::timestamptz, coalesce(p->'sale_payload','{}'::jsonb), '{}'::jsonb,
    p->>'request_fingerprint')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('state', 'created', 'id', v_id);
END $$;

-- Recover by original op + shift (+ server-verified actor/location). cancel_if_absent writes a permanent tombstone
-- only when no attempt exists; an existing attempt is never cancelled here.
CREATE OR REPLACE FUNCTION public.pos_payment_op_recover(p_client_op_id text, p_shift_id uuid, p_operator_id uuid,
  p_location_id uuid, p_cancel_if_absent boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.pos_payment_attempts%ROWTYPE;
  v_t public.pos_payment_op_tombstones%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-pay-op:' || p_client_op_id, 0));
  SELECT * INTO v_row FROM public.pos_payment_attempts WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_row.shift_id <> p_shift_id OR v_row.operator_id <> p_operator_id OR v_row.location_id <> p_location_id THEN
      RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
    END IF;
    RETURN jsonb_build_object('state', 'attempt', 'id', v_row.id);
  END IF;
  SELECT * INTO v_t FROM public.pos_payment_op_tombstones WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_t.shift_id <> p_shift_id OR v_t.operator_id <> p_operator_id OR v_t.location_id <> p_location_id THEN
      RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
    END IF;
    RETURN jsonb_build_object('state', 'cancelled');
  END IF;
  IF NOT p_cancel_if_absent THEN RETURN jsonb_build_object('state', 'none'); END IF;
  INSERT INTO public.pos_payment_op_tombstones (client_op_id, location_id, shift_id, operator_id)
  VALUES (p_client_op_id, p_location_id, p_shift_id, p_operator_id);
  RETURN jsonb_build_object('state', 'cancelled');
END $$;

REVOKE ALL ON FUNCTION public.pos_payment_attempt_reserve(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pos_payment_op_recover(text, uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_payment_attempt_reserve(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_payment_op_recover(text, uuid, uuid, uuid, boolean) TO service_role;