ALTER TABLE public.pos_customer_coupons DROP CONSTRAINT IF EXISTS pos_customer_coupons_status_check;
ALTER TABLE public.pos_customer_coupons ADD CONSTRAINT pos_customer_coupons_status_check
  CHECK (status = ANY (ARRAY['active','reserved','used','expired','void','frozen']));
ALTER TABLE public.pos_customer_coupons ADD COLUMN IF NOT EXISTS provider_status_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS pos_customer_coupons_youzan_sync_idx
  ON public.pos_customer_coupons (provider_status_checked_at NULLS FIRST, created_at, id)
  WHERE external_provider = 'youzan' AND status IN ('active','frozen');

CREATE OR REPLACE FUNCTION public.commerce_newcomer_claim_scoped(p_limit integer, p_lease_seconds integer, p_customer_ids uuid[])
RETURNS TABLE (slot_id uuid, claim_token uuid, mode text, request_key text, customer_id uuid,
               youzan_coupon_group_id text, threshold_fen integer, amount_fen integer, validity_days integer, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_customer_ids IS NOT NULL AND cardinality(p_customer_ids) = 0 THEN RETURN; END IF;
  UPDATE commerce_newcomer_grant_slots SET status = 'unknown', claim_token = NULL, lease_until = NULL,
    last_error = 'lease_expired_result_unknown', updated_at = now()
   WHERE status IN ('dispatching','reconciling') AND lease_until < clock_timestamp();
  RETURN QUERY
  WITH picked AS (
    SELECT s.id FROM commerce_newcomer_grant_slots s
      JOIN commerce_newcomer_grants g0 ON g0.id = s.grant_id
     WHERE s.status IN ('pending','retry_wait','unknown') AND s.next_run_at <= now()
       AND (p_customer_ids IS NULL OR g0.customer_id = ANY (p_customer_ids))
     ORDER BY s.next_run_at, s.id LIMIT GREATEST(1, LEAST(p_limit, 50)) FOR UPDATE OF s SKIP LOCKED
  ), upd AS (
    UPDATE commerce_newcomer_grant_slots s SET
      status = CASE WHEN s.status = 'unknown' THEN 'reconciling' ELSE 'dispatching' END,
      claim_token = gen_random_uuid(), lease_until = clock_timestamp() + make_interval(secs => GREATEST(30, p_lease_seconds)),
      attempts = s.attempts + 1, updated_at = now()
    FROM picked WHERE s.id = picked.id RETURNING s.*
  )
  SELECT u.id, u.claim_token, CASE WHEN u.status = 'reconciling' THEN 'reconcile' ELSE 'dispatch' END,
         u.request_key, g.customer_id, b.youzan_coupon_group_id, b.threshold_fen, b.amount_fen, v.validity_days, u.attempts
    FROM upd u JOIN commerce_newcomer_grants g ON g.id = u.grant_id
    JOIN commerce_newcomer_benefit_versions v ON v.id = g.version_id
    JOIN commerce_newcomer_benefit_slots b ON b.version_id = g.version_id AND b.slot_no = u.slot_no;
END $$;

CREATE OR REPLACE FUNCTION public.commerce_newcomer_backfill_scoped(p_limit integer, p_customer_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c RECORD; v_n integer := 0;
BEGIN
  IF p_customer_ids IS NOT NULL AND cardinality(p_customer_ids) = 0 THEN RETURN 0; END IF;
  FOR c IN
    SELECT cu.id FROM commerce_customers cu
    WHERE cu.status = 'active' AND COALESCE(btrim(cu.phone), '') <> ''
      AND (p_customer_ids IS NULL OR cu.id = ANY (p_customer_ids))
      AND NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants g WHERE g.customer_id = cu.id)
      AND NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants g
                      WHERE g.phone_key = encode(sha256(convert_to(regexp_replace(cu.phone, '\D', '', 'g'), 'UTF8')), 'hex'))
    ORDER BY cu.created_at, cu.id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 50))
  LOOP
    IF public.commerce_newcomer_enroll(c.id, NULL) ->> 'status' = 'created' THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.commerce_youzan_mirror_apply_status(p_mirror uuid, p_external_id text, p_status text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m pos_customer_coupons;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('active','frozen','used','void','expired') THEN RETURN 'invalid_status'; END IF;
  SELECT * INTO m FROM pos_customer_coupons WHERE id = p_mirror AND external_provider = 'youzan' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF m.status NOT IN ('active','frozen') THEN RETURN 'terminal'; END IF;
  IF p_status IS NOT NULL AND m.external_id IS DISTINCT FROM p_external_id THEN
    UPDATE pos_customer_coupons SET provider_status_checked_at = now() WHERE id = p_mirror;
    RETURN 'id_mismatch';
  END IF;
  IF p_status IS NULL OR p_status = m.status THEN
    UPDATE pos_customer_coupons SET provider_status_checked_at = now() WHERE id = p_mirror;
    RETURN 'checked';
  END IF;
  UPDATE pos_customer_coupons SET status = p_status, provider_status_checked_at = now(), updated_at = now(),
    metadata = metadata || jsonb_build_object('provider_status', p_status, 'provider_status_at', now())
   WHERE id = p_mirror;
  RETURN 'updated';
END $$;

REVOKE ALL ON FUNCTION public.commerce_newcomer_claim_scoped(integer, integer, uuid[]),
  public.commerce_newcomer_backfill_scoped(integer, uuid[]),
  public.commerce_youzan_mirror_apply_status(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_newcomer_claim_scoped(integer, integer, uuid[]),
  public.commerce_newcomer_backfill_scoped(integer, uuid[]),
  public.commerce_youzan_mirror_apply_status(uuid, text, text) TO service_role;