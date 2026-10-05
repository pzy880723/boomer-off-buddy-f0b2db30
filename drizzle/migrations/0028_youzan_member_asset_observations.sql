-- 0028: 有赞会员资产只读观察快照。
-- 不是本地可花余额/券；不写 pos_customer_wallets / pos_customer_coupons / 积分账本。
CREATE TABLE public.youzan_member_asset_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kdt_id bigint NOT NULL,
  yz_open_id text NOT NULL CHECK (length(yz_open_id) BETWEEN 1 AND 128),
  asset_kind text NOT NULL CHECK (asset_kind IN ('points','coupon')),
  asset_key text NOT NULL DEFAULT '' CHECK (length(asset_key) <= 128),
  customer_id uuid NOT NULL,
  observed jsonb NOT NULL CHECK (jsonb_typeof(observed) = 'object'),
  observed_at timestamptz NOT NULL,
  query_source text NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  last_inbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kdt_id, yz_open_id, asset_kind, asset_key),
  CHECK ((asset_kind = 'points' AND asset_key = '') OR (asset_kind = 'coupon' AND asset_key <> ''))
);
COMMENT ON TABLE public.youzan_member_asset_observations IS
  'READ-ONLY external observation of Youzan member assets. NOT spendable local balance/coupons; never copy into wallets, pos_customer_coupons or points ledger.';

GRANT SELECT ON public.youzan_member_asset_observations TO authenticated;
GRANT ALL ON public.youzan_member_asset_observations TO service_role;
ALTER TABLE public.youzan_member_asset_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hq read asset observations" ON public.youzan_member_asset_observations
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE FUNCTION public.youzan_asset_observation_version(
  p_kdt_id bigint, p_yz_open_id text, p_asset_kind text, p_asset_key text)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT row_version FROM youzan_member_asset_observations
    WHERE kdt_id = p_kdt_id AND yz_open_id = p_yz_open_id AND asset_kind = p_asset_kind AND asset_key = p_asset_key), 0)
$$;

CREATE FUNCTION public.youzan_asset_observation_record(
  p_inbox_id uuid, p_claim_token uuid, p_kdt_id bigint, p_yz_open_id text,
  p_asset_kind text, p_asset_key text, p_customer_id uuid, p_observed jsonb,
  p_observed_at timestamptz, p_expected_row_version integer, p_query_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inbox record; v_cur record;
BEGIN
  IF p_asset_kind NOT IN ('points','coupon') OR p_observed IS NULL OR jsonb_typeof(p_observed) <> 'object'
     OR p_customer_id IS NULL OR p_observed_at IS NULL OR p_observed_at > now() + interval '1 minute'
     OR p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN
    RAISE EXCEPTION 'invalid observation' USING ERRCODE = '22023';
  END IF;
  SELECT id, kdt_id INTO v_inbox FROM youzan_member_asset_inbox
   WHERE id = p_inbox_id AND status = 'processing' AND claim_token = p_claim_token
     AND p_claim_token IS NOT NULL AND lease_until > now()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','stale_lease'); END IF;
  IF v_inbox.kdt_id <> p_kdt_id THEN RAISE EXCEPTION 'kdt mismatch' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM youzan_shops WHERE kdt_id = p_kdt_id AND status = 'active') THEN
    RAISE EXCEPTION 'shop not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT row_version, observed_at INTO v_cur FROM youzan_member_asset_observations
   WHERE kdt_id = p_kdt_id AND yz_open_id = p_yz_open_id AND asset_kind = p_asset_kind AND asset_key = p_asset_key
   FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_row_version <> 0 THEN RETURN jsonb_build_object('result','stale_version'); END IF;
    INSERT INTO youzan_member_asset_observations
      (kdt_id, yz_open_id, asset_kind, asset_key, customer_id, observed, observed_at, query_source, last_inbox_id)
    VALUES (p_kdt_id, p_yz_open_id, p_asset_kind, p_asset_key, p_customer_id, p_observed, p_observed_at, left(p_query_source, 60), p_inbox_id)
    ON CONFLICT (kdt_id, yz_open_id, asset_kind, asset_key) DO NOTHING;
    IF NOT FOUND THEN RETURN jsonb_build_object('result','stale_version'); END IF;
  ELSE
    IF v_cur.row_version <> p_expected_row_version THEN RETURN jsonb_build_object('result','stale_version'); END IF;
    IF p_observed_at <= v_cur.observed_at THEN
      UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'superseded_by_newer_observation',
        claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
      RETURN jsonb_build_object('result','older_observation');
    END IF;
    UPDATE youzan_member_asset_observations SET customer_id = p_customer_id, observed = p_observed,
      observed_at = p_observed_at, query_source = left(p_query_source, 60), last_inbox_id = p_inbox_id,
      row_version = row_version + 1, updated_at = now()
     WHERE kdt_id = p_kdt_id AND yz_open_id = p_yz_open_id AND asset_kind = p_asset_kind AND asset_key = p_asset_key;
  END IF;
  UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'observed_asset_adapter_not_connected',
    claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
  RETURN jsonb_build_object('result','recorded');
END $$;

REVOKE ALL ON FUNCTION public.youzan_asset_observation_version(bigint,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_asset_observation_record(uuid,uuid,bigint,text,text,text,uuid,jsonb,timestamptz,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_asset_observation_version(bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_asset_observation_record(uuid,uuid,bigint,text,text,text,uuid,jsonb,timestamptz,integer,text) TO service_role;