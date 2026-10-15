-- 有赞积分只读投影：有赞是积分唯一权威来源。ERP 只做展示与审计镜像。
-- 不读不写 pos_customer_wallets / commerce_points_ledger / 0062-0063 自主账本。仅 service_role。
CREATE TABLE public.youzan_points_projection (
  customer_id uuid PRIMARY KEY,
  kdt_id bigint,
  yz_open_id text CHECK (yz_open_id IS NULL OR length(yz_open_id) BETWEEN 1 AND 128),
  balance bigint CHECK (balance IS NULL OR balance >= 0),
  points_account_version numeric(20,0) CHECK (points_account_version IS NULL OR points_account_version >= 0),
  balance_synced_at timestamptz,
  balance_failed_at timestamptz,
  balance_failure text CHECK (balance_failure IS NULL OR balance_failure ~ '^[a-z0-9_]{1,60}$'),
  log_synced_at timestamptz,
  log_window_start timestamptz,
  log_failed_at timestamptz,
  log_failure text CHECK (log_failure IS NULL OR log_failure ~ '^[a-z0-9_]{1,60}$'),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kdt_id IS NULL) = (yz_open_id IS NULL)),
  CHECK (balance IS NULL OR (yz_open_id IS NOT NULL AND points_account_version IS NOT NULL AND balance_synced_at IS NOT NULL))
);
CREATE UNIQUE INDEX youzan_points_projection_member_uq ON public.youzan_points_projection (kdt_id, yz_open_id) WHERE yz_open_id IS NOT NULL;
CREATE INDEX youzan_points_projection_refresh_idx ON public.youzan_points_projection (balance_synced_at NULLS FIRST) WHERE yz_open_id IS NOT NULL;
COMMENT ON TABLE public.youzan_points_projection IS
  'Read-only projection of Youzan (authoritative) member points. Not spendable; never copied into wallets or the ERP points ledger.';

CREATE TABLE public.youzan_points_log_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  kdt_id bigint NOT NULL,
  yz_open_id text NOT NULL CHECK (length(yz_open_id) BETWEEN 1 AND 128),
  entry_key text NOT NULL CHECK (entry_key ~ '^[0-9a-f]{64}$'),
  amount bigint NOT NULL,
  balance_after bigint,
  description text CHECK (description IS NULL OR length(description) <= 200),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  biz_value text CHECK (biz_value IS NULL OR length(biz_value) <= 128),
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, kdt_id, yz_open_id, entry_key)
);
CREATE INDEX youzan_points_log_entries_list_idx ON public.youzan_points_log_entries (customer_id, occurred_at DESC, id DESC);
COMMENT ON TABLE public.youzan_points_log_entries IS
  'Append-only mirror of official Youzan points change logs (changelog.search). Only official log rows; never synthesized.';

REVOKE ALL ON public.youzan_points_projection FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.youzan_points_log_entries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.youzan_points_projection TO service_role;
GRANT ALL ON public.youzan_points_log_entries TO service_role;
ALTER TABLE public.youzan_points_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youzan_points_log_entries ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.youzan_points_projection_lock(p_customer_id uuid)
RETURNS public.youzan_points_projection LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r youzan_points_projection;
BEGIN
  INSERT INTO youzan_points_projection (customer_id) VALUES (p_customer_id) ON CONFLICT (customer_id) DO NOTHING;
  SELECT * INTO r FROM youzan_points_projection WHERE customer_id = p_customer_id FOR UPDATE;
  RETURN r;
END $$;

CREATE FUNCTION public.youzan_points_projection_record_balance(
  p_customer_id uuid, p_kdt_id bigint, p_yz_open_id text, p_point bigint, p_version text, p_started_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r youzan_points_projection; v numeric;
BEGIN
  IF p_customer_id IS NULL OR p_kdt_id IS NULL OR p_yz_open_id IS NULL OR length(p_yz_open_id) NOT BETWEEN 1 AND 128
     OR p_point IS NULL OR p_point < 0 OR p_version IS NULL OR p_version !~ '^[0-9]{1,20}$'
     OR p_started_at IS NULL OR p_started_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'invalid youzan points snapshot' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customers WHERE id = p_customer_id AND status = 'active') THEN
    RETURN jsonb_build_object('result','customer_inactive');
  END IF;
  IF EXISTS (SELECT 1 FROM youzan_points_projection WHERE kdt_id = p_kdt_id AND yz_open_id = p_yz_open_id AND customer_id <> p_customer_id) THEN
    RETURN jsonb_build_object('result','identity_conflict');
  END IF;
  v := p_version::numeric;
  r := youzan_points_projection_lock(p_customer_id);
  IF r.yz_open_id IS NOT NULL AND (r.kdt_id <> p_kdt_id OR r.yz_open_id <> p_yz_open_id) THEN
    RETURN jsonb_build_object('result','identity_conflict');
  END IF;
  IF r.points_account_version IS NOT NULL AND v < r.points_account_version THEN
    RETURN jsonb_build_object('result','stale');
  END IF;
  IF r.points_account_version IS NOT NULL AND v = r.points_account_version THEN
    IF r.balance IS DISTINCT FROM p_point THEN RETURN jsonb_build_object('result','version_conflict'); END IF;
    UPDATE youzan_points_projection SET balance_synced_at = greatest(balance_synced_at, p_started_at), updated_at = now()
     WHERE customer_id = p_customer_id;
    RETURN jsonb_build_object('result','same_version');
  END IF;
  UPDATE youzan_points_projection SET kdt_id = p_kdt_id, yz_open_id = p_yz_open_id, balance = p_point,
    points_account_version = v, balance_synced_at = greatest(coalesce(balance_synced_at, p_started_at), p_started_at),
    row_version = row_version + 1, updated_at = now()
   WHERE customer_id = p_customer_id;
  RETURN jsonb_build_object('result','applied');
END $$;

CREATE FUNCTION public.youzan_points_projection_record_failure(
  p_customer_id uuid, p_kind text, p_reason text, p_attempted_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r youzan_points_projection;
BEGIN
  IF p_customer_id IS NULL OR p_kind NOT IN ('balance','log') OR p_reason IS NULL OR p_reason !~ '^[a-z0-9_]{1,60}$'
     OR p_attempted_at IS NULL OR p_attempted_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'invalid youzan points failure' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customers WHERE id = p_customer_id) THEN
    RETURN jsonb_build_object('result','customer_missing');
  END IF;
  r := youzan_points_projection_lock(p_customer_id);
  IF p_kind = 'balance' THEN
    IF r.balance_failed_at IS NOT NULL AND r.balance_failed_at >= p_attempted_at THEN RETURN jsonb_build_object('result','older_failure'); END IF;
    UPDATE youzan_points_projection SET balance_failed_at = p_attempted_at, balance_failure = p_reason, updated_at = now() WHERE customer_id = p_customer_id;
  ELSE
    IF r.log_failed_at IS NOT NULL AND r.log_failed_at >= p_attempted_at THEN RETURN jsonb_build_object('result','older_failure'); END IF;
    UPDATE youzan_points_projection SET log_failed_at = p_attempted_at, log_failure = p_reason, updated_at = now() WHERE customer_id = p_customer_id;
  END IF;
  RETURN jsonb_build_object('result','recorded');
END $$;

CREATE FUNCTION public.youzan_points_projection_record_logs(
  p_customer_id uuid, p_kdt_id bigint, p_yz_open_id text, p_entries jsonb, p_window_start timestamptz, p_started_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r youzan_points_projection; e jsonb; n integer := 0; k integer;
BEGIN
  IF p_customer_id IS NULL OR p_kdt_id IS NULL OR p_yz_open_id IS NULL OR p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) > 500 OR p_window_start IS NULL OR p_started_at IS NULL
     OR p_started_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'invalid youzan points logs' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customers WHERE id = p_customer_id AND status = 'active') THEN
    RETURN jsonb_build_object('result','customer_inactive','inserted',0);
  END IF;
  IF EXISTS (SELECT 1 FROM youzan_points_projection WHERE kdt_id = p_kdt_id AND yz_open_id = p_yz_open_id AND customer_id <> p_customer_id) THEN
    RETURN jsonb_build_object('result','identity_conflict','inserted',0);
  END IF;
  r := youzan_points_projection_lock(p_customer_id);
  IF r.yz_open_id IS NOT NULL AND (r.kdt_id <> p_kdt_id OR r.yz_open_id <> p_yz_open_id) THEN
    RETURN jsonb_build_object('result','identity_conflict','inserted',0);
  END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    IF (e->>'entry_key') !~ '^[0-9a-f]{64}$' OR (e->>'amount') !~ '^-?[0-9]{1,15}$' OR (e->>'occurred_at') !~ '^[0-9]{1,12}$' THEN
      RAISE EXCEPTION 'invalid youzan points log entry' USING ERRCODE = '22023';
    END IF;
    INSERT INTO youzan_points_log_entries (customer_id, kdt_id, yz_open_id, entry_key, amount, balance_after, description, occurred_at, expires_at, biz_value)
    VALUES (p_customer_id, p_kdt_id, p_yz_open_id, e->>'entry_key', (e->>'amount')::bigint,
      CASE WHEN (e->>'balance_after') ~ '^-?[0-9]{1,15}$' THEN (e->>'balance_after')::bigint END,
      left(e->>'description', 200), to_timestamp((e->>'occurred_at')::bigint),
      CASE WHEN (e->>'expires_at') ~ '^[0-9]{1,12}$' THEN to_timestamp((e->>'expires_at')::bigint) END,
      left(e->>'biz_value', 128))
    ON CONFLICT (customer_id, kdt_id, yz_open_id, entry_key) DO NOTHING;
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  END LOOP;
  UPDATE youzan_points_projection SET kdt_id = p_kdt_id, yz_open_id = p_yz_open_id,
    log_synced_at = greatest(coalesce(log_synced_at, p_started_at), p_started_at),
    log_window_start = CASE WHEN log_synced_at IS NULL OR p_started_at >= log_synced_at THEN p_window_start ELSE log_window_start END,
    updated_at = now()
   WHERE customer_id = p_customer_id;
  RETURN jsonb_build_object('result','recorded','inserted',n);
END $$;

REVOKE ALL ON FUNCTION public.youzan_points_projection_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_points_projection_record_balance(uuid,bigint,text,bigint,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_points_projection_record_failure(uuid,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_points_projection_record_logs(uuid,bigint,text,jsonb,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_points_projection_record_balance(uuid,bigint,text,bigint,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_points_projection_record_failure(uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_points_projection_record_logs(uuid,bigint,text,jsonb,timestamptz,timestamptz) TO service_role;
