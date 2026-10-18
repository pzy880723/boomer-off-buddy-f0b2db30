-- 新人券包全量上线准备：自动登记 + 有界补漏 + 槽位规则不可变 + finish 同事务写有赞镜像 + v2 草稿版本。
-- 规则不变：有赞是唯一核销权威；每客户/规范手机号终身一包；开关默认关闭；不动积分/钱包/账本。
-- 全部对象 service_role 专用；触发器失败只 WARNING，绝不阻断注册。

-- 1) verify_code 派生（与 TS deriveVerifyCode 完全一致：'ncv' + sha256(request_key) 前 12 位 hex）
CREATE OR REPLACE FUNCTION public.commerce_newcomer_verify_code(p_request_key text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT 'ncv' || substr(encode(sha256(convert_to(p_request_key, 'UTF8')), 'hex'), 1, 12)
$$;

-- 2) 新注册/手机号首次验证后自动登记：不依赖用户点会员码；冲突不合并不发；异常只告警不阻断注册
CREATE OR REPLACE FUNCTION public.commerce_newcomer_auto_enroll()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'active' AND COALESCE(btrim(NEW.phone), '') <> '' THEN
    BEGIN
      PERFORM public.commerce_newcomer_enroll(NEW.id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'newcomer auto enroll failed for %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commerce_newcomer_auto_enroll ON public.commerce_customers;
CREATE TRIGGER commerce_newcomer_auto_enroll
  AFTER INSERT OR UPDATE OF phone, status ON public.commerce_customers
  FOR EACH ROW EXECUTE FUNCTION public.commerce_newcomer_auto_enroll();

-- 3) 有界补漏：存量 active 真实消费者 + 有效手机号、无 grant、同手机号未占用；一次最多 50 个
CREATE OR REPLACE FUNCTION public.commerce_newcomer_backfill(p_limit integer DEFAULT 20)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c RECORD; v_n integer := 0; v_status text;
BEGIN
  FOR c IN
    SELECT cu.id FROM commerce_customers cu
    WHERE cu.status = 'active' AND COALESCE(btrim(cu.phone), '') <> ''
      AND NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants g WHERE g.customer_id = cu.id)
      AND NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants g
                      WHERE g.phone_key = encode(sha256(convert_to(regexp_replace(cu.phone, '\D', '', 'g'), 'UTF8')), 'hex'))
    ORDER BY cu.created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 50))
  LOOP
    v_status := public.commerce_newcomer_enroll(c.id, NULL) ->> 'status';
    IF v_status = 'created' THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $$;

-- 4) 槽位规则不可变：版本已有登记后，门槛/面额/有赞模板绑定不得再改（防已登记规则被换）
CREATE OR REPLACE FUNCTION public.commerce_newcomer_slot_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE version_id = OLD.version_id)
     AND (NEW.threshold_fen IS DISTINCT FROM OLD.threshold_fen
          OR NEW.amount_fen IS DISTINCT FROM OLD.amount_fen
          OR NEW.youzan_coupon_group_id IS DISTINCT FROM OLD.youzan_coupon_group_id) THEN
    RAISE EXCEPTION 'newcomer slot rules are immutable once the version has grants';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commerce_newcomer_slot_immutable ON public.commerce_newcomer_benefit_slots;
CREATE TRIGGER commerce_newcomer_slot_immutable
  BEFORE UPDATE ON public.commerce_newcomer_benefit_slots
  FOR EACH ROW EXECUTE FUNCTION public.commerce_newcomer_slot_immutable();

-- 5) 有赞镜像唯一性：同一外部券 ID 不能落到两个槽位/两个客户
CREATE UNIQUE INDEX IF NOT EXISTS pos_customer_coupons_youzan_external_id_uniq
  ON public.pos_customer_coupons (external_provider, external_id) WHERE external_provider IS NOT NULL;

-- 6) finish 升级：succeeded 同事务写 pos_customer_coupons 有赞镜像（幂等；不造本地券、不解除结算过滤）
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
  -- 回查不到也绝不回到 dispatch 重发：not_found 保持 unknown（资金不明留 attention 可观察）
  v_status := CASE p_outcome
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'retry' THEN CASE WHEN s.attempts >= 8 THEN 'failed' ELSE 'retry_wait' END
    WHEN 'not_found' THEN 'unknown'
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
  IF v_status = 'succeeded' THEN
    INSERT INTO pos_customer_coupons (customer_id, code, name, discount_type, value, min_spend, status,
      starts_at, expires_at, metadata, external_provider, external_id, idempotency_key, scope)
    SELECT g.customer_id,
           public.commerce_newcomer_verify_code(s.request_key),
           '新人券 满' || trim(to_char(b.threshold_fen / 100.0, 'FM999990.00')) || '减'
             || trim(to_char(b.amount_fen / 100.0, 'FM999990.00')),
           'amount', b.amount_fen / 100.0, b.threshold_fen / 100.0, 'active',
           now(), now() + make_interval(days => v.validity_days),
           jsonb_build_object(
             'grant_id', g.id, 'slot_id', s.id, 'slot_no', s.slot_no,
             'activity_id', b.youzan_coupon_group_id, 'requestId', s.request_key,
             'verify_code', public.commerce_newcomer_verify_code(s.request_key),
             'redemption_authority', 'youzan', 'local_checkout_eligible', false,
             'source', 'newcomer_pack'),
           'youzan', p_coupon_id, s.request_key || ':youzan-mirror', 'platform'
      FROM commerce_newcomer_grants g
      JOIN commerce_newcomer_benefit_versions v ON v.id = g.version_id
      JOIN commerce_newcomer_benefit_slots b ON b.version_id = g.version_id AND b.slot_no = s.slot_no
     WHERE g.id = s.grant_id
       AND NOT EXISTS (SELECT 1 FROM pos_customer_coupons m WHERE m.idempotency_key = s.request_key || ':youzan-mirror');
  END IF;
  UPDATE commerce_newcomer_grants g SET updated_at = now(), status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots x WHERE x.grant_id = g.id AND x.status <> 'succeeded') THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots x WHERE x.grant_id = g.id AND x.status IN ('failed','blocked')) THEN 'attention'
      ELSE 'issuing' END
    WHERE g.id = s.grant_id;
  RETURN v_status;
END $$;

-- 7) v2 全量版本：draft + 模板 ID 留空，待 Codex 在腾讯固定出口创建生产模板并绑定后才启用
INSERT INTO public.commerce_newcomer_benefit_versions (id, status, validity_days, note)
VALUES ('newcomer_v2', 'draft', 90, '全量新人券包：满49.9减5×4、满99减10×2、满299减30×2；生产模板待Codex绑定后启用')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.commerce_newcomer_benefit_slots (version_id, slot_no, threshold_fen, amount_fen) VALUES
  ('newcomer_v2',1,4990,500),('newcomer_v2',2,4990,500),('newcomer_v2',3,4990,500),('newcomer_v2',4,4990,500),
  ('newcomer_v2',5,9900,1000),('newcomer_v2',6,9900,1000),('newcomer_v2',7,29900,3000),('newcomer_v2',8,29900,3000)
ON CONFLICT (version_id, slot_no) DO NOTHING;

-- 8) 权限：全部 service_role 专用
REVOKE ALL ON FUNCTION public.commerce_newcomer_verify_code(text), public.commerce_newcomer_auto_enroll(),
  public.commerce_newcomer_backfill(integer), public.commerce_newcomer_slot_immutable(),
  public.commerce_newcomer_finish(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_newcomer_verify_code(text), public.commerce_newcomer_backfill(integer),
  public.commerce_newcomer_finish(uuid, uuid, text, text, text) TO service_role;