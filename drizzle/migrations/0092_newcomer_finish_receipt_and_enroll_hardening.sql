-- P1 修复：成功回执必须携带并校验 provider 真实凭证；enroll 严格校验真实消费者与版本完整性。
-- 1) enroll 加固：大陆手机正则 + external_subject + 同手机号 active 唯一 + 版本完整(8槽/10000分/全绑定/90天)
CREATE OR REPLACE FUNCTION public.commerce_newcomer_enroll(p_customer uuid, p_location uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ver text; c commerce_customers; v_key text; v_digits text; g commerce_newcomer_grants;
BEGIN
  SELECT * INTO c FROM commerce_customers WHERE id = p_customer AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','customer_unavailable'); END IF;
  SELECT * INTO g FROM commerce_newcomer_grants WHERE customer_id = p_customer;
  IF FOUND THEN RETURN jsonb_build_object('status','existing','grant_id',g.id,'grant_status',g.status); END IF;
  -- 真实消费者条件：external_subject 必填、大陆手机号、同号 active 唯一
  IF COALESCE(btrim(c.external_subject),'') = '' THEN RETURN jsonb_build_object('status','identity_incomplete'); END IF;
  v_digits := regexp_replace(COALESCE(c.phone,''), '\D', '', 'g');
  IF v_digits !~ '^1[3-9]\d{9}$' THEN RETURN jsonb_build_object('status','phone_invalid'); END IF;
  IF EXISTS (SELECT 1 FROM commerce_customers o WHERE o.id <> c.id AND o.status = 'active'
             AND regexp_replace(COALESCE(o.phone,''), '\D', '', 'g') = v_digits) THEN
    RETURN jsonb_build_object('status','identity_conflict');
  END IF;
  -- 版本完整性：active 且 8 槽、总面额 10000 分、全部模板已绑定、90 天；不完整宁可不发
  SELECT id INTO v_ver FROM commerce_newcomer_benefit_versions WHERE status = 'active';
  IF v_ver IS NULL THEN RETURN jsonb_build_object('status','disabled'); END IF;
  IF (SELECT count(*) FROM commerce_newcomer_benefit_slots s WHERE s.version_id = v_ver) <> 8
     OR (SELECT count(*) FROM commerce_newcomer_benefit_slots s WHERE s.version_id = v_ver AND s.youzan_coupon_group_id IS NOT NULL) <> 8
     OR (SELECT COALESCE(sum(s.amount_fen),0) FROM commerce_newcomer_benefit_slots s WHERE s.version_id = v_ver) <> 10000
     OR (SELECT validity_days FROM commerce_newcomer_benefit_versions WHERE id = v_ver) <> 90 THEN
    RETURN jsonb_build_object('status','version_incomplete');
  END IF;
  v_key := encode(sha256(convert_to(v_digits, 'UTF8')), 'hex');
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

-- 2) 新独立 RPC：成功必须携带 provider 真实回执并逐字段校验；镜像插入失败整事务回滚（唯一索引兜底）
CREATE OR REPLACE FUNCTION public.commerce_newcomer_finish_success(p_slot uuid, p_token uuid,
  p_coupon_id text, p_verify_code text, p_valid_start timestamptz, p_valid_end timestamptz,
  p_amount_fen integer, p_threshold_fen integer, p_activity_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s commerce_newcomer_grant_slots; b commerce_newcomer_benefit_slots;
        g commerce_newcomer_grants; v commerce_newcomer_benefit_versions; v_mismatch text;
BEGIN
  SELECT * INTO s FROM commerce_newcomer_grant_slots WHERE id = p_slot FOR UPDATE;
  IF NOT FOUND OR s.claim_token IS DISTINCT FROM p_token OR p_token IS NULL
     OR s.status NOT IN ('dispatching','reconciling') OR s.lease_until <= clock_timestamp() THEN
    RETURN 'stale';
  END IF;
  SELECT * INTO g FROM commerce_newcomer_grants WHERE id = s.grant_id;
  SELECT * INTO v FROM commerce_newcomer_benefit_versions WHERE id = g.version_id;
  SELECT * INTO b FROM commerce_newcomer_benefit_slots WHERE version_id = g.version_id AND slot_no = s.slot_no;
  v_mismatch := CASE
    WHEN COALESCE(btrim(p_coupon_id),'') = '' OR COALESCE(btrim(p_verify_code),'') = '' THEN 'receipt_incomplete'
    WHEN p_valid_start IS NULL OR p_valid_end IS NULL OR p_valid_end <= p_valid_start THEN 'bad_validity'
    WHEN p_amount_fen IS DISTINCT FROM b.amount_fen OR p_threshold_fen IS DISTINCT FROM b.threshold_fen THEN 'amount_mismatch'
    WHEN p_activity_id IS DISTINCT FROM b.youzan_coupon_group_id THEN 'activity_mismatch'
    ELSE NULL END;
  IF v_mismatch IS NOT NULL THEN
    UPDATE commerce_newcomer_grant_slots SET status = 'unknown', claim_token = NULL, lease_until = NULL,
      last_error = 'receipt_mismatch:' || v_mismatch, next_run_at = now() + interval '5 minutes', updated_at = now()
     WHERE id = p_slot;
    UPDATE commerce_newcomer_grants SET status = 'attention', updated_at = now() WHERE id = s.grant_id;
    RETURN 'receipt_mismatch';
  END IF;
  UPDATE commerce_newcomer_grant_slots SET status = 'succeeded', youzan_coupon_id = p_coupon_id,
    last_error = NULL, claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE id = p_slot;
  INSERT INTO pos_customer_coupons (customer_id, code, name, discount_type, value, min_spend, status,
    starts_at, expires_at, metadata, external_provider, external_id, idempotency_key, scope)
  VALUES (g.customer_id, p_verify_code,
    '新人券 满' || trim(to_char(p_threshold_fen / 100.0, 'FM999990.00')) || '减'
      || trim(to_char(p_amount_fen / 100.0, 'FM999990.00')),
    'amount', p_amount_fen / 100.0, p_threshold_fen / 100.0, 'active',
    p_valid_start, p_valid_end,
    jsonb_build_object(
      'grant_id', g.id, 'slot_id', s.id, 'slot_no', s.slot_no,
      'activity_id', p_activity_id, 'requestId', s.request_key,
      'verify_code', p_verify_code, 'receipt_validated', true,
      'redemption_authority', 'youzan', 'local_checkout_eligible', false,
      'source', 'newcomer_pack'),
    'youzan', p_coupon_id, s.request_key || ':youzan-mirror', 'platform');
  UPDATE commerce_newcomer_grants g2 SET updated_at = now(), status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots x WHERE x.grant_id = g2.id AND x.status <> 'succeeded') THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots x WHERE x.grant_id = g2.id AND x.status IN ('failed','blocked')) THEN 'attention'
      ELSE 'issuing' END
    WHERE g2.id = s.grant_id;
  RETURN 'succeeded';
END $$;

-- 3) 旧 5 参 finish：只负责非成功状态；无真实凭证的成功一律拒绝为 receipt_required，不写镜像
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
  IF p_outcome = 'succeeded' THEN
    UPDATE commerce_newcomer_grant_slots SET status = 'unknown', claim_token = NULL, lease_until = NULL,
      last_error = 'receipt_required', next_run_at = now() + interval '5 minutes', updated_at = now()
     WHERE id = p_slot;
    RETURN 'receipt_required';
  END IF;
  IF p_outcome = 'not_found' AND s.status <> 'reconciling' THEN p_outcome := 'unknown'; END IF;
  v_status := CASE p_outcome
    WHEN 'retry' THEN CASE WHEN s.attempts >= 8 THEN 'failed' ELSE 'retry_wait' END
    WHEN 'not_found' THEN 'unknown'
    WHEN 'rejected' THEN 'failed'
    WHEN 'blocked' THEN 'blocked'
    ELSE 'unknown' END;
  UPDATE commerce_newcomer_grant_slots SET status = v_status,
    last_error = left(COALESCE(p_error, p_outcome), 300),
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

-- 4) 权限
REVOKE ALL ON FUNCTION public.commerce_newcomer_finish_success(uuid, uuid, text, text, timestamptz, timestamptz, integer, integer, text),
  public.commerce_newcomer_enroll(uuid, uuid), public.commerce_newcomer_finish(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_newcomer_finish_success(uuid, uuid, text, text, timestamptz, timestamptz, integer, integer, text),
  public.commerce_newcomer_enroll(uuid, uuid), public.commerce_newcomer_finish(uuid, uuid, text, text, text) TO service_role;