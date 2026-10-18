\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION t(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;

-- 准备：v2 绑定真实模板并激活（v1 退回 draft，避免双 active）
UPDATE commerce_newcomer_benefit_versions SET status='draft' WHERE id='newcomer_v1';
UPDATE commerce_newcomer_benefit_slots SET youzan_coupon_group_id = CASE
  WHEN slot_no BETWEEN 1 AND 4 THEN '35074448'
  WHEN slot_no BETWEEN 5 AND 6 THEN '35074450' ELSE '35074452' END
 WHERE version_id='newcomer_v2';
UPDATE commerce_newcomer_benefit_versions SET status='active' WHERE id='newcomer_v2';

-- enroll 严格校验：非法手机号拒绝
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000001','sub-x1','12345','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000001'), 'non-mainland phone rejected');
-- 缺 external_subject 拒绝
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000002','','18600000021','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000002'), 'missing external_subject rejected');
-- 同手机号另一 active 消费者拒绝（身份不一致）
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000003','sub-x3','18600000022','active'),
  ('a0000000-0000-0000-0000-000000000004','sub-x4','186 0000 0022','active');
SELECT t((SELECT count(*)=1 FROM commerce_newcomer_grants g JOIN commerce_customers cu ON cu.id=g.customer_id
  WHERE regexp_replace(cu.phone,'\D','','g')='18600000022'), 'duplicate active phone: exactly one grant');
-- 合法消费者自动登记成功
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000003'), 'valid consumer enrolled on v2');

-- 旧 5 参 finish 拒绝无真实凭证的成功
CREATE TEMP TABLE f1 AS SELECT * FROM commerce_newcomer_claim(1, 60);
SELECT t(commerce_newcomer_finish(slot_id, claim_token, 'succeeded', 'yz-x', NULL)='receipt_required', 'legacy finish rejects receipt-less success') FROM f1;
SELECT t(NOT EXISTS (SELECT 1 FROM pos_customer_coupons WHERE external_id='yz-x'), 'legacy success writes no mirror');
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots WHERE status='unknown' AND last_error='receipt_required'), 'receipt-less success parked as unknown');

-- 新 RPC：真实回执成功，镜像用真实日期与 provider verify_code
CREATE TEMP TABLE f2 AS SELECT * FROM commerce_newcomer_claim(1, 60);
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-real-001', 'YZVC001',
  '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', 500, 4990, '35074448')='succeeded', 'finish_success with real receipt') FROM f2;
SELECT t(EXISTS (SELECT 1 FROM pos_customer_coupons m WHERE m.external_provider='youzan' AND m.external_id='yz-real-001'
  AND m.code='YZVC001' AND m.starts_at='2026-10-18 00:00:00+08' AND m.expires_at='2027-01-15 23:59:59+08'
  AND m.value=5.00 AND m.min_spend=49.90 AND (m.metadata->>'receipt_validated')::boolean=true), 'mirror uses provider dates and verify_code');

-- 回执与槽位规则不符：金额错误 → 拒绝且无镜像
CREATE TEMP TABLE f3 AS SELECT * FROM commerce_newcomer_claim(1, 60);
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-bad-amt', 'YZVC002',
  '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', 1000, 4990, '35074448')='receipt_mismatch', 'wrong amount rejected') FROM f3;
SELECT t(NOT EXISTS (SELECT 1 FROM pos_customer_coupons WHERE external_id='yz-bad-amt'), 'mismatch writes no mirror');
-- 活动不符 → 拒绝
CREATE TEMP TABLE f4 AS SELECT * FROM commerce_newcomer_claim(1, 60);
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-bad-act', 'YZVC003',
  '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', 1000, 9900, '35074448')='receipt_mismatch', 'wrong activity rejected') FROM f4;
-- 日期倒置 → 拒绝
CREATE TEMP TABLE f5 AS SELECT * FROM commerce_newcomer_claim(1, 60);
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-bad-date', 'YZVC004',
  '2027-01-15 23:59:59+08', '2026-10-18 00:00:00+08', 1000, 9900, '35074450')='receipt_mismatch', 'inverted dates rejected') FROM f5;
-- 同券 ID 跨槽 → 唯一约束拒绝，整槽回滚（槽位仍可重领）
CREATE TEMP TABLE f6 AS SELECT * FROM commerce_newcomer_claim(1, 60);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM f6 LOOP
    PERFORM commerce_newcomer_finish_success(r.slot_id, r.claim_token, 'yz-real-001', 'YZVC009',
      '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', 500, 4990, '35074448');
    RAISE EXCEPTION 'FAIL duplicate coupon id across slots accepted';
  END LOOP;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS duplicate coupon id rolls back whole slot';
END $$;
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots s JOIN f6 ON f6.slot_id=s.id
  WHERE s.status='dispatching'), 'rolled-back slot not marked succeeded');

-- enroll 拒绝不完整版本：模板未绑定的 active 版本不得发礼包
UPDATE commerce_newcomer_benefit_versions SET status='draft' WHERE id='newcomer_v2';
UPDATE commerce_newcomer_benefit_slots SET youzan_coupon_group_id=NULL WHERE version_id='newcomer_v2' AND slot_no=8;
UPDATE commerce_newcomer_benefit_versions SET status='active' WHERE id='newcomer_v2';
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000005','sub-x5','18600000025','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000005'), 'active version with unbound slot enrolls nothing');
-- 恢复 v2 完整并激活
UPDATE commerce_newcomer_benefit_slots SET youzan_coupon_group_id='35074452' WHERE version_id='newcomer_v2' AND slot_no=8;
SELECT t((SELECT commerce_newcomer_enroll('a0000000-0000-0000-0000-000000000005', NULL)->>'status')='created', 'complete v2 enrolls');

-- 权限
SELECT t(NOT has_function_privilege('authenticated','commerce_newcomer_finish_success(uuid,uuid,text,text,timestamptz,timestamptz,integer,integer,text)','EXECUTE'), 'finish_success service-role only');
