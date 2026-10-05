-- 0031: 观察快照不得静默换主人。已有行 customer_id 与本次可信映射不一致 → inbox blocked identity_mapping_conflict（清 claim/lease），
-- 不覆写快照，返回 identity_conflict；积分与券、同版本与高版本一律适用。其余 0030 规则不变。
CREATE OR REPLACE FUNCTION public.youzan_asset_observation_record(
  p_inbox_id uuid, p_claim_token uuid, p_kdt_id bigint, p_yz_open_id text,
  p_asset_kind text, p_asset_key text, p_customer_id uuid, p_observed jsonb,
  p_observed_at timestamptz, p_expected_row_version integer, p_query_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inbox record; v_cur record; v_point numeric; v_ver numeric; v_cur_ver numeric; v_cur_point numeric;
  j_point jsonb; j_ver jsonb;
BEGIN
  IF p_asset_kind NOT IN ('points','coupon') OR p_observed IS NULL OR jsonb_typeof(p_observed) <> 'object'
     OR p_customer_id IS NULL OR p_observed_at IS NULL OR p_observed_at > now() + interval '1 minute'
     OR p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN
    RAISE EXCEPTION 'invalid observation' USING ERRCODE = '22023';
  END IF;
  IF p_asset_kind = 'points' THEN
    j_point := p_observed -> 'point';
    j_ver := p_observed -> 'points_account_version';
    IF j_point IS NULL OR NOT (
         (jsonb_typeof(j_point) = 'number' AND (j_point #>> '{}') ~ '^[0-9]{1,15}$')
      OR (jsonb_typeof(j_point) = 'string' AND (j_point #>> '{}') ~ '^[0-9]{1,15}$')) THEN
      RAISE EXCEPTION 'invalid point' USING ERRCODE = '22023';
    END IF;
    IF j_ver IS NULL OR NOT (
         (jsonb_typeof(j_ver) = 'number' AND (j_ver #>> '{}') ~ '^[0-9]{1,20}$')
      OR (jsonb_typeof(j_ver) = 'string' AND (j_ver #>> '{}') ~ '^[0-9]{1,20}$')) THEN
      RAISE EXCEPTION 'invalid points_account_version' USING ERRCODE = '22023';
    END IF;
    v_point := (j_point #>> '{}')::numeric;
    v_ver := (j_ver #>> '{}')::numeric;
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
  SELECT row_version, observed_at, observed, customer_id INTO v_cur FROM youzan_member_asset_observations
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
    IF v_cur.customer_id IS DISTINCT FROM p_customer_id THEN
      UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'identity_mapping_conflict',
        claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
      RETURN jsonb_build_object('result','identity_conflict');
    END IF;
    IF v_cur.row_version <> p_expected_row_version THEN RETURN jsonb_build_object('result','stale_version'); END IF;
    IF p_asset_kind = 'points' THEN
      v_cur_ver := (v_cur.observed #>> '{points_account_version}')::numeric;
      v_cur_point := (v_cur.observed #>> '{point}')::numeric;
      IF v_ver < v_cur_ver THEN
        UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'superseded_by_newer_observation',
          claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
        RETURN jsonb_build_object('result','older_observation');
      ELSIF v_ver = v_cur_ver THEN
        IF v_point <> v_cur_point THEN
          UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'points_version_conflict',
            claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
          RETURN jsonb_build_object('result','version_conflict');
        END IF;
        UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'observed_asset_adapter_not_connected',
          claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
        RETURN jsonb_build_object('result','same_version_observed');
      END IF;
      UPDATE youzan_member_asset_observations SET customer_id = p_customer_id, observed = p_observed,
        observed_at = greatest(observed_at, p_observed_at), query_source = left(p_query_source, 60),
        last_inbox_id = p_inbox_id, row_version = row_version + 1, updated_at = now()
       WHERE kdt_id = p_kdt_id AND yz_open_id = p_yz_open_id AND asset_kind = p_asset_kind AND asset_key = p_asset_key;
    ELSE
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
  END IF;
  UPDATE youzan_member_asset_inbox SET status = 'blocked', reason = 'observed_asset_adapter_not_connected',
    claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_inbox_id;
  RETURN jsonb_build_object('result','recorded');
END $$;

REVOKE ALL ON FUNCTION public.youzan_asset_observation_record(uuid,uuid,bigint,text,text,text,uuid,jsonb,timestamptz,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_asset_observation_record(uuid,uuid,bigint,text,text,text,uuid,jsonb,timestamptz,integer,text) TO service_role;