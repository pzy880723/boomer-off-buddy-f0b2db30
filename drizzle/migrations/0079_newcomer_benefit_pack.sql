-- 新人券包（版本化 8 槽位）+ 耐久发放作业。有赞是可核销券唯一权威：槽位只有在有赞返回成功后才记 succeeded；
-- 写入结果未知 → unknown，只能回查，不重发。版本默认 draft（发放关闭）。全部对象 service_role 专用。
CREATE TABLE public.commerce_newcomer_benefit_versions (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  validity_days integer NOT NULL CHECK (validity_days > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_newcomer_one_active ON public.commerce_newcomer_benefit_versions ((true)) WHERE status = 'active';
CREATE TABLE public.commerce_newcomer_benefit_slots (
  version_id text NOT NULL REFERENCES public.commerce_newcomer_benefit_versions(id),
  slot_no integer NOT NULL CHECK (slot_no BETWEEN 1 AND 20),
  threshold_fen integer NOT NULL CHECK (threshold_fen >= 0),
  amount_fen integer NOT NULL CHECK (amount_fen > 0),
  youzan_coupon_group_id text,
  PRIMARY KEY (version_id, slot_no)
);
CREATE TABLE public.commerce_newcomer_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES public.commerce_customers(id),
  phone_key text UNIQUE,
  version_id text NOT NULL REFERENCES public.commerce_newcomer_benefit_versions(id),
  source_location_id uuid,
  status text NOT NULL DEFAULT 'issuing' CHECK (status IN ('issuing','completed','attention')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.commerce_newcomer_grant_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES public.commerce_newcomer_grants(id),
  slot_no integer NOT NULL,
  request_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dispatching','retry_wait','unknown','reconciling','succeeded','failed','blocked')),
  attempts integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  youzan_coupon_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grant_id, slot_no)
);
CREATE INDEX commerce_newcomer_slots_due ON public.commerce_newcomer_grant_slots (status, next_run_at);

GRANT ALL ON public.commerce_newcomer_benefit_versions, public.commerce_newcomer_benefit_slots,
  public.commerce_newcomer_grants, public.commerce_newcomer_grant_slots TO service_role;
REVOKE ALL ON public.commerce_newcomer_benefit_versions, public.commerce_newcomer_benefit_slots,
  public.commerce_newcomer_grants, public.commerce_newcomer_grant_slots FROM PUBLIC, anon, authenticated;
ALTER TABLE public.commerce_newcomer_benefit_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_newcomer_benefit_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_newcomer_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_newcomer_grant_slots ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.commerce_newcomer_enroll(p_customer uuid, p_location uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ver text; c commerce_customers; v_key text; g commerce_newcomer_grants;
BEGIN
  SELECT * INTO c FROM commerce_customers WHERE id = p_customer AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','customer_unavailable'); END IF;
  SELECT * INTO g FROM commerce_newcomer_grants WHERE customer_id = p_customer;
  IF FOUND THEN RETURN jsonb_build_object('status','existing','grant_id',g.id,'grant_status',g.status); END IF;
  SELECT id INTO v_ver FROM commerce_newcomer_benefit_versions WHERE status = 'active';
  IF v_ver IS NULL THEN RETURN jsonb_build_object('status','disabled'); END IF;
  IF COALESCE(btrim(c.phone),'') = '' THEN RETURN jsonb_build_object('status','phone_required'); END IF;
  v_key := encode(sha256(convert_to(regexp_replace(c.phone, '\D', '', 'g'), 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('newcomer:' || v_key, 0));
  IF EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE phone_key = v_key) THEN
    RETURN jsonb_build_object('status','identity_conflict');
  END IF;
  INSERT INTO commerce_newcomer_grants (customer_id, phone_key, version_id, source_location_id)
  VALUES (p_customer, v_key, v_ver, p_location) RETURNING * INTO g;
  INSERT INTO commerce_newcomer_grant_slots (grant_id, slot_no, request_key)
  SELECT g.id, s.slot_no, 'nc:' || g.id || ':' || s.slot_no
    FROM commerce_newcomer_benefit_slots s WHERE s.version_id = v_ver ORDER BY s.slot_no;
  RETURN jsonb_build_object('status','created','grant_id',g.id);
END $$;

CREATE OR REPLACE FUNCTION public.commerce_newcomer_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (slot_id uuid, claim_token uuid, mode text, request_key text, customer_id uuid,
               youzan_coupon_group_id text, threshold_fen integer, amount_fen integer, validity_days integer, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE commerce_newcomer_grant_slots SET status = 'unknown', claim_token = NULL, lease_until = NULL,
    last_error = 'lease_expired_result_unknown', updated_at = now()
   WHERE status IN ('dispatching','reconciling') AND lease_until < clock_timestamp();
  RETURN QUERY
  WITH picked AS (
    SELECT s.id FROM commerce_newcomer_grant_slots s
     WHERE s.status IN ('pending','retry_wait','unknown') AND s.next_run_at <= now()
     ORDER BY s.next_run_at, s.id LIMIT GREATEST(1, LEAST(p_limit, 50)) FOR UPDATE SKIP LOCKED
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

CREATE OR REPLACE FUNCTION public.commerce_newcomer_finish(p_slot uuid, p_token uuid, p_outcome text,
  p_coupon_id text, p_error text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s commerce_newcomer_grant_slots; v_status text;
BEGIN
  SELECT * INTO s FROM commerce_newcomer_grant_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR s.claim_token IS DISTINCT FROM p_token OR p_token IS NULL
     OR s.status NOT IN ('dispatching','reconciling') OR s.lease_until <= clock_timestamp() THEN
    RETURN 'stale';
  END IF;
  IF p_outcome = 'succeeded' AND COALESCE(btrim(p_coupon_id),'') = '' THEN p_outcome := 'unknown'; END IF;
  IF p_outcome = 'not_found' AND s.status <> 'reconciling' THEN p_outcome := 'unknown'; END IF;
  v_status := CASE p_outcome
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'retry' THEN CASE WHEN s.attempts >= 8 THEN 'failed' ELSE 'retry_wait' END
    WHEN 'not_found' THEN 'retry_wait'
    WHEN 'rejected' THEN 'failed'
    WHEN 'blocked' THEN 'blocked'
    ELSE 'unknown' END;
  UPDATE commerce_newcomer_grant_slots SET status = v_status,
    youzan_coupon_id = CASE WHEN v_status = 'succeeded' THEN p_coupon_id ELSE youzan_coupon_id END,
    last_error = CASE WHEN v_status = 'succeeded' THEN NULL ELSE left(COALESCE(p_error, p_outcome), 300) END,
    claim_token = NULL, lease_until = NULL, updated_at = now(),
    next_run_at = CASE v_status
      WHEN 'retry_wait' THEN now() + make_interval(secs => LEAST(3600, 30 * (2 ^ LEAST(s.attempts, 7))::int))
      WHEN 'unknown' THEN now() + interval '5 minutes' ELSE next_run_at END
   WHERE id = p_slot;
  UPDATE commerce_newcomer_grants g SET updated_at = now(), status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots x WHERE x.grant_id = g.id AND x.status <> 'succeeded') THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots x WHERE x.grant_id = g.id AND x.status IN ('failed','blocked')) THEN 'attention'
      ELSE 'issuing' END
   WHERE g.id = s.grant_id;
  RETURN v_status;
END $$;

CREATE OR REPLACE FUNCTION public.commerce_newcomer_retry(p_grant uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  UPDATE commerce_newcomer_grant_slots SET status = 'pending', next_run_at = now(), last_error = NULL, updated_at = now()
   WHERE grant_id = p_grant AND status IN ('failed','blocked');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE commerce_newcomer_grants SET status = 'issuing', updated_at = now() WHERE id = p_grant AND v_n > 0;
  RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.commerce_newcomer_summary(p_customer uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT jsonb_build_object(
      'status', CASE g.status WHEN 'completed' THEN 'issued' WHEN 'attention' THEN 'needs_retry' ELSE 'processing' END,
      'total_slots', count(s.*), 'issued_slots', count(s.*) FILTER (WHERE s.status = 'succeeded'))
    FROM commerce_newcomer_grants g JOIN commerce_newcomer_grant_slots s ON s.grant_id = g.id
    WHERE g.customer_id = p_customer GROUP BY g.id, g.status), jsonb_build_object('status','not_enrolled'))
$$;

REVOKE ALL ON FUNCTION public.commerce_newcomer_enroll(uuid, uuid), public.commerce_newcomer_claim(integer, integer),
  public.commerce_newcomer_finish(uuid, uuid, text, text, text), public.commerce_newcomer_retry(uuid),
  public.commerce_newcomer_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_newcomer_enroll(uuid, uuid), public.commerce_newcomer_claim(integer, integer),
  public.commerce_newcomer_finish(uuid, uuid, text, text, text), public.commerce_newcomer_retry(uuid),
  public.commerce_newcomer_summary(uuid) TO service_role;

INSERT INTO public.commerce_newcomer_benefit_versions (id, status, validity_days, note)
VALUES ('newcomer_v1', 'draft', 90, '满49.9减5×4、满99减10×2、满299减30×2');
INSERT INTO public.commerce_newcomer_benefit_slots (version_id, slot_no, threshold_fen, amount_fen) VALUES
  ('newcomer_v1',1,4990,500),('newcomer_v1',2,4990,500),('newcomer_v1',3,4990,500),('newcomer_v1',4,4990,500),
  ('newcomer_v1',5,9900,1000),('newcomer_v1',6,9900,1000),('newcomer_v1',7,29900,3000),('newcomer_v1',8,29900,3000);