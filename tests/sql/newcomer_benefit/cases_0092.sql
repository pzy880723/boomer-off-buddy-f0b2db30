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
-- 同手机号两个 active 消费者：fail-closed，两个都不发（AFTER 触发器在语句末尾触发，双方互相可见）
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000003','sub-x3','18600000022','active'),
  ('a0000000-0000-0000-0000-000000000004','sub-x4','186 0000 0022','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants g JOIN commerce_customers cu ON cu.id=g.customer_id
  WHERE regexp_replace(cu.phone,'\D','','g')='18600000022'), 'duplicate active phone: neither enrolled (fail-closed)');
-- 手机号唯一的合法消费者自动登记成功
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-00000000000a','sub-xa','18600000024','active');
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-00000000000a'), 'valid consumer enrolled on v2');

-- 只让 v2 授权（sub-xa）的槽位可领取，避免领到 v1 槽位
UPDATE commerce_newcomer_grant_slots s SET next_run_at = now() + interval '1 hour'
  FROM commerce_newcomer_grants g
 WHERE g.id = s.grant_id AND g.customer_id <> 'a0000000-0000-0000-0000-00000000000a' AND s.status <> 'succeeded';
-- 领取辅助：带回槽位规则
CREATE OR REPLACE FUNCTION pg_temp.claim1() RETURNS TABLE(slot_id uuid, claim_token uuid, amt integer, thr integer, act text) LANGUAGE sql AS $$
  SELECT c.slot_id, c.claim_token, b.amount_fen, b.threshold_fen, b.youzan_coupon_group_id
    FROM commerce_newcomer_claim(1, 60) c
    JOIN commerce_newcomer_grant_slots s ON s.id = c.slot_id
    JOIN commerce_newcomer_grants g ON g.id = s.grant_id
    JOIN commerce_newcomer_benefit_slots b ON b.version_id = g.version_id AND b.slot_no = s.slot_no
$$;

-- 旧 5 参 finish 拒绝无真实凭证的成功
CREATE TEMP TABLE f1 AS SELECT * FROM pg_temp.claim1();
SELECT t(commerce_newcomer_finish(slot_id, claim_token, 'succeeded', 'yz-x', NULL)='receipt_required', 'legacy finish rejects receipt-less success') FROM f1;
SELECT t(NOT EXISTS (SELECT 1 FROM pos_customer_coupons WHERE external_id='yz-x'), 'legacy success writes no mirror');
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots WHERE status='unknown' AND last_error='receipt_required'), 'receipt-less success parked as unknown');

-- 新 RPC：真实回执成功，镜像用真实日期与 provider verify_code
CREATE TEMP TABLE f2 AS SELECT * FROM pg_temp.claim1();
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-real-001', 'YZVC001',
  '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', amt, thr, act)='succeeded', 'finish_success with real receipt') FROM f2;
SELECT t(EXISTS (SELECT 1 FROM pos_customer_coupons m JOIN f2 ON m.value = f2.amt / 100.0 AND m.min_spend = f2.thr / 100.0
  WHERE m.external_provider='youzan' AND m.external_id='yz-real-001'
  AND m.code='YZVC001' AND m.starts_at='2026-10-18 00:00:00+08' AND m.expires_at='2027-01-15 23:59:59+08'
  AND (m.metadata->>'receipt_validated')::boolean=true), 'mirror uses provider dates and verify_code');

-- 回执与槽位规则不符：金额错误 → 拒绝且无镜像
CREATE TEMP TABLE f3 AS SELECT * FROM pg_temp.claim1();
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-bad-amt', 'YZVC002',
  '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', amt + 1, thr, act)='receipt_mismatch', 'wrong amount rejected') FROM f3;
SELECT t(NOT EXISTS (SELECT 1 FROM pos_customer_coupons WHERE external_id='yz-bad-amt'), 'mismatch writes no mirror');
-- 活动不符 → 拒绝
CREATE TEMP TABLE f4 AS SELECT * FROM pg_temp.claim1();
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-bad-act', 'YZVC003',
  '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', amt, thr, '00000000')='receipt_mismatch', 'wrong activity rejected') FROM f4;
-- 日期倒置 → 拒绝
CREATE TEMP TABLE f5 AS SELECT * FROM pg_temp.claim1();
SELECT t(commerce_newcomer_finish_success(slot_id, claim_token, 'yz-bad-date', 'YZVC004',
  '2027-01-15 23:59:59+08', '2026-10-18 00:00:00+08', amt, thr, act)='receipt_mismatch', 'inverted dates rejected') FROM f5;
-- 同券 ID 跨槽 → 唯一约束拒绝，整槽回滚（槽位仍可重领）
CREATE TEMP TABLE f6 AS SELECT * FROM pg_temp.claim1();
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM f6 LOOP
    PERFORM commerce_newcomer_finish_success(r.slot_id, r.claim_token, 'yz-real-001', 'YZVC009',
      '2026-10-18 00:00:00+08', '2027-01-15 23:59:59+08', r.amt, r.thr, r.act);
    RAISE EXCEPTION 'FAIL duplicate coupon id across slots accepted';
  END LOOP;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS duplicate coupon id rolls back whole slot';
END $$;
SELECT t(EXISTS (SELECT 1 FROM commerce_newcomer_grant_slots s JOIN f6 ON f6.slot_id=s.id
  WHERE s.status='dispatching'), 'rolled-back slot not marked succeeded');

-- enroll 拒绝不完整版本：用新草稿版本 v3 模拟"模板未绑全就激活"（v2 已有登记，规则不可变）
INSERT INTO commerce_newcomer_benefit_versions (id, status, validity_days) VALUES ('newcomer_v3', 'draft', 90);
INSERT INTO commerce_newcomer_benefit_slots (version_id, slot_no, threshold_fen, amount_fen) VALUES
  ('newcomer_v3',1,4990,500),('newcomer_v3',2,4990,500),('newcomer_v3',3,4990,500),('newcomer_v3',4,4990,500),
  ('newcomer_v3',5,9900,1000),('newcomer_v3',6,9900,1000),('newcomer_v3',7,29900,3000),('newcomer_v3',8,29900,3000);
UPDATE commerce_newcomer_benefit_slots SET youzan_coupon_group_id='35074448' WHERE version_id='newcomer_v3' AND slot_no BETWEEN 1 AND 7;
UPDATE commerce_newcomer_benefit_versions SET status='draft' WHERE id='newcomer_v2';
UPDATE commerce_newcomer_benefit_versions SET status='active' WHERE id='newcomer_v3';
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000005','sub-x5','18600000025','active');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000005'), 'active version with unbound slot enrolls nothing');
-- 补全绑定后恢复 v2 激活，登记成功
UPDATE commerce_newcomer_benefit_versions SET status='draft' WHERE id='newcomer_v3';
UPDATE commerce_newcomer_benefit_versions SET status='active' WHERE id='newcomer_v2';
SELECT t((SELECT commerce_newcomer_enroll('a0000000-0000-0000-0000-000000000005', NULL)->>'status')='created', 'complete v2 enrolls');

-- 权限
SELECT t(NOT has_function_privilege('authenticated','commerce_newcomer_finish_success(uuid,uuid,text,text,timestamptz,timestamptz,integer,integer,text)','EXECUTE'), 'finish_success service-role only');
