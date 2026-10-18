\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION t(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;

-- 夹具：真实 pos_customer_coupons 的关键约束（唯一 code、状态/类型 CHECK、镜像列）
CREATE TABLE public.pos_customer_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('amount','percentage')),
  value numeric NOT NULL CHECK (value > 0),
  min_spend numeric NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','used','expired','void')),
  starts_at timestamptz, expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  definition_id uuid, source text NOT NULL DEFAULT 'erp',
  external_provider text, external_id text, idempotency_key text,
  scope text NOT NULL DEFAULT 'platform' CHECK (scope IN ('platform','store')),
  location_id uuid, reserved_order_id uuid);

-- verify_code 与 TS 同一向量
SELECT t(public.commerce_newcomer_verify_code('nc:c39fd499-9345-4906-b829-0f3f80ae4e9d:1') = 'ncv4a2677cae13b', 'verify_code matches TS vector');
SELECT t(public.commerce_newcomer_verify_code('nc:g:1') ~ '^[a-z0-9]{15}$' AND public.commerce_newcomer_verify_code('nc:g:1') NOT ILIKE 'zan%', 'verify_code format safe');

-- 版本 draft 时自动登记不发生（cases.sql 已激活 v1，先退回 draft 验证）
UPDATE commerce_newcomer_benefit_versions SET status='draft' WHERE id='newcomer_v1';
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a1','18600000011','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'draft version: trigger enrolls nothing');

-- 激活 v1 后：新注册自动登记
UPDATE commerce_newcomer_benefit_versions SET status='active' WHERE id='newcomer_v1';
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','b1','18600000012','active');
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'new customer auto-enrolled by trigger');
SELECT t((SELECT count(*)=8 FROM commerce_newcomer_grant_slots s JOIN commerce_newcomer_grants g ON g.id=s.grant_id WHERE g.customer_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'auto enroll creates 8 slots');

-- 手机号首次验证（NULL/空 → 有效）触发登记
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','c1',NULL,'active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='cccccccc-cccc-cccc-cccc-cccccccccccc'), 'no phone: not enrolled');
UPDATE commerce_customers SET phone='18600000013' WHERE id='cccccccc-cccc-cccc-cccc-cccccccccccc';
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='cccccccc-cccc-cccc-cccc-cccccccccccc'), 'phone first verified triggers enroll');

-- 同手机号冲突不合并、不发
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','d1','186 0000 0013','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='dddddddd-dddd-dddd-dddd-dddddddddddd'), 'same normalized phone conflict: no grant');

-- 有界补漏：存量无 grant 客户登记（aaaa draft 期间未登记 + cases.sql 的 3333），已有 grant/同手机号/inactive 跳过
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','e1','18600000014','inactive');
SELECT t(public.commerce_newcomer_backfill(20) = 2, 'backfill enrolls exactly pending eligible customers');
SELECT t(public.commerce_newcomer_backfill(20) = 0, 'backfill idempotent: second run enrolls nothing');

-- 槽位规则不可变：版本已有登记后禁止改门槛/面额/模板
DO $$
BEGIN
  UPDATE commerce_newcomer_benefit_slots SET amount_fen = 999 WHERE version_id='newcomer_v1' AND slot_no=1;
  RAISE EXCEPTION 'FAIL immutable slot rule not enforced';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '%immutable%' THEN RAISE NOTICE 'PASS slot rules immutable after grants'; ELSE RAISE; END IF;
END $$;
-- draft 的 v2 无登记，允许绑定模板（Codex 绑定路径）
UPDATE commerce_newcomer_benefit_slots SET youzan_coupon_group_id='35074001' WHERE version_id='newcomer_v2' AND slot_no=1;
SELECT t((SELECT youzan_coupon_group_id='35074001' FROM commerce_newcomer_benefit_slots WHERE version_id='newcomer_v2' AND slot_no=1), 'draft v2 template binding allowed');

-- finish succeeded 同事务写有赞镜像
CREATE TEMP TABLE c1 AS SELECT * FROM commerce_newcomer_claim(1, 60);
SELECT t(commerce_newcomer_finish(slot_id, claim_token, 'succeeded', 'yz-coupon-001', NULL)='succeeded', 'finish succeeded') FROM c1;
SELECT t(EXISTS (SELECT 1 FROM pos_customer_coupons m JOIN commerce_newcomer_grant_slots s ON m.idempotency_key = s.request_key || ':youzan-mirror'
  WHERE m.external_provider='youzan' AND m.external_id='yz-coupon-001' AND m.status='active'
    AND m.value=5.00 AND m.min_spend=49.90 AND m.code=public.commerce_newcomer_verify_code(s.request_key)
    AND m.metadata->>'redemption_authority'='youzan' AND (m.metadata->>'local_checkout_eligible')::boolean=false), 'mirror written with youzan authority, not local-checkout eligible');
SELECT t((SELECT expires_at > now() + interval '89 days' AND expires_at < now() + interval '91 days' FROM pos_customer_coupons WHERE external_id='yz-coupon-001'), 'mirror validity 90 days');

-- 同一外部券 ID 不能落到第二个槽位
CREATE TEMP TABLE c2 AS SELECT * FROM commerce_newcomer_claim(1, 60);
DO $$
BEGIN
  PERFORM commerce_newcomer_finish(slot_id, claim_token, 'succeeded', 'yz-coupon-001', NULL) FROM c2;
  RAISE EXCEPTION 'FAIL duplicate external coupon id accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS duplicate youzan coupon id rejected';
END $$;

-- not_found 在 reconcile 路径保持 unknown，不回到 retry_wait/dispatch
UPDATE commerce_newcomer_grant_slots SET status='unknown', claim_token=NULL, lease_until=NULL, next_run_at=now()
 WHERE status IN ('dispatching','pending','retry_wait');
CREATE TEMP TABLE c3 AS SELECT * FROM commerce_newcomer_claim(50, 60) WHERE mode='reconcile';
SELECT t((SELECT count(*) >= 1 FROM c3), 'unknown slots claimed as reconcile');
SELECT t(commerce_newcomer_finish(slot_id, claim_token, 'not_found', NULL, NULL)='unknown', 'reconcile not_found stays unknown') FROM c3 LIMIT 1;
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots WHERE status='retry_wait'), 'not_found never returns to dispatch queue');

-- v2 草稿存在、规则与 v1 一致、模板待绑定
SELECT t((SELECT status='draft' AND validity_days=90 FROM commerce_newcomer_benefit_versions WHERE id='newcomer_v2'), 'v2 draft 90 days');
SELECT t((SELECT count(*)=8 AND sum(amount_fen)=10000 FROM commerce_newcomer_benefit_slots WHERE version_id='newcomer_v2'), 'v2 = 8 slots, 100 yuan');

-- 权限：service-role 专用
SELECT t(NOT has_function_privilege('authenticated','commerce_newcomer_backfill(integer)','EXECUTE')
  AND NOT has_function_privilege('anon','commerce_newcomer_verify_code(text)','EXECUTE'), 'new functions service-role only');
