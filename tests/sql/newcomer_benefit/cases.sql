\set ON_ERROR_STOP 1
CREATE FUNCTION t(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('11111111-1111-1111-1111-111111111111','s1','186 0000 0001','active'),
  ('22222222-2222-2222-2222-222222222222','s2','18600000001','active'),
  ('33333333-3333-3333-3333-333333333333','s3','18600000003','active');

-- 默认关闭
SELECT t(commerce_newcomer_enroll('11111111-1111-1111-1111-111111111111', NULL)->>'status'='disabled', 'draft version issues nothing');
SELECT t((SELECT count(*)=8 AND sum(amount_fen)=10000 FROM commerce_newcomer_benefit_slots WHERE version_id='newcomer_v1'), 'v1 = 8 slots, 100 yuan');
SELECT t((SELECT validity_days=90 FROM commerce_newcomer_benefit_versions WHERE id='newcomer_v1'), 'v1 valid 90 days');
UPDATE commerce_newcomer_benefit_versions SET status='active' WHERE id='newcomer_v1';

-- 幂等：同会员两次 / 跨门店只一次
SELECT t(commerce_newcomer_enroll('11111111-1111-1111-1111-111111111111', NULL)->>'status'='created', 'first enroll creates grant');
SELECT t(commerce_newcomer_enroll('11111111-1111-1111-1111-111111111111', gen_random_uuid())->>'status'='existing', 'second enroll other store is existing');
SELECT t((SELECT count(*)=8 FROM commerce_newcomer_grant_slots), 'exactly 8 slots');
-- 同手机号的另一身份不重发
SELECT t(commerce_newcomer_enroll('22222222-2222-2222-2222-222222222222', NULL)->>'status'='identity_conflict', 'same phone other identity blocked');
-- 手机号变更后同会员仍不重发
UPDATE commerce_customers SET phone='18699999999' WHERE id='11111111-1111-1111-1111-111111111111';
SELECT t(commerce_newcomer_enroll('11111111-1111-1111-1111-111111111111', NULL)->>'status'='existing', 'phone change does not re-grant');

-- 作业：领取 → 成功必须带有赞券 id
CREATE TEMP TABLE c1 AS SELECT * FROM commerce_newcomer_claim(3, 60);
SELECT t((SELECT count(*)=3 AND bool_and(mode='dispatch') FROM c1), 'claim 3 for dispatch');
SELECT t((SELECT count(*)=0 FROM commerce_newcomer_claim(3,60) x WHERE x.slot_id IN (SELECT slot_id FROM c1)), 'claimed slots not double-claimed');
SELECT t(commerce_newcomer_finish((SELECT slot_id FROM c1 ORDER BY slot_id LIMIT 1), gen_random_uuid(), 'succeeded', 'yz1', NULL)='stale', 'wrong token fenced');
SELECT t(commerce_newcomer_finish(s, tok, 'succeeded', '', NULL)='unknown', 'success without coupon id is unknown')
  FROM (SELECT slot_id s, claim_token tok FROM c1 ORDER BY slot_id OFFSET 1 LIMIT 1) x;
SELECT t(commerce_newcomer_finish(s, tok, 'succeeded', 'yz-a', NULL)='succeeded', 'success recorded')
  FROM (SELECT slot_id s, claim_token tok FROM c1 ORDER BY slot_id LIMIT 1) x;
SELECT t(commerce_newcomer_finish(s, tok, 'succeeded', 'yz-a', NULL)='stale', 'duplicate finish stale')
  FROM (SELECT slot_id s, claim_token tok FROM c1 ORDER BY slot_id LIMIT 1) x;
SELECT t(commerce_newcomer_finish(s, tok, 'retry', NULL, 'timeout_before_send')='retry_wait', 'retryable waits')
  FROM (SELECT slot_id s, claim_token tok FROM c1 ORDER BY slot_id OFFSET 2 LIMIT 1) x;

-- 未知结果只回查：unknown 槽位领取为 reconcile，不是 dispatch
UPDATE commerce_newcomer_grant_slots SET next_run_at = now() WHERE status = 'unknown';
CREATE TEMP TABLE c2 AS SELECT * FROM commerce_newcomer_claim(50, 60) WHERE mode = 'reconcile';
SELECT t((SELECT count(*)=1 FROM c2), 'unknown slot claimed only for reconcile');
-- 回查找到 → succeeded；不新增写
SELECT t(commerce_newcomer_finish(slot_id, claim_token, 'succeeded', 'yz-found', NULL)='succeeded', 'reconcile found marks succeeded') FROM c2;
-- 租约过期的 dispatching → unknown（不会被当作可重发）
UPDATE commerce_newcomer_grant_slots SET lease_until = now() - interval '1 second' WHERE status = 'dispatching';
SELECT count(*) FROM commerce_newcomer_claim(0, 60);
SELECT t((SELECT count(*)=0 FROM commerce_newcomer_grant_slots WHERE status='dispatching' AND lease_until < now()), 'expired lease never stays dispatching');
SELECT t((SELECT bool_and(status IN ('unknown','reconciling','succeeded','retry_wait','pending','dispatching')) FROM commerce_newcomer_grant_slots), 'states valid');
UPDATE commerce_newcomer_grant_slots SET status='unknown', claim_token=NULL, lease_until=NULL, next_run_at = now() + interval '1 hour' WHERE status IN ('unknown','reconciling');
-- 未发出的 not_found 在写路径上不被接受
SELECT t(commerce_newcomer_finish(slot_id, claim_token, 'not_found', NULL, NULL)='unknown', 'not_found on dispatch path stays unknown')
  FROM commerce_newcomer_claim(1, 60) WHERE mode='dispatch' LIMIT 1;
-- 拒绝 → failed → grant attention；运维重试只放回 failed
SELECT commerce_newcomer_finish(slot_id, claim_token, 'rejected', NULL, 'template_invalid') FROM commerce_newcomer_claim(1, 60) WHERE mode='dispatch' LIMIT 1;
SELECT t((SELECT status='attention' FROM commerce_newcomer_grants WHERE customer_id='11111111-1111-1111-1111-111111111111'), 'failed slot surfaces attention');
SELECT t((SELECT commerce_newcomer_summary('11111111-1111-1111-1111-111111111111')->>'status')='needs_retry', 'summary shows needs_retry');
SELECT t(commerce_newcomer_retry((SELECT id FROM commerce_newcomer_grants LIMIT 1))=1, 'retry requeues only failed');
SELECT t((SELECT count(*)=2 FROM commerce_newcomer_grant_slots WHERE status='succeeded'), 'succeeded slots untouched');
-- 全部成功 → completed / issued
UPDATE commerce_newcomer_grant_slots SET status='pending', next_run_at=now() WHERE status <> 'succeeded';
SELECT commerce_newcomer_finish(slot_id, claim_token, 'succeeded', 'yz-' || slot_id, NULL) FROM commerce_newcomer_claim(50, 60);
SELECT t((SELECT status='completed' FROM commerce_newcomer_grants LIMIT 1) AND commerce_newcomer_summary('11111111-1111-1111-1111-111111111111')->>'status'='issued', 'all 8 issued completes');
SELECT t(commerce_newcomer_summary('33333333-3333-3333-3333-333333333333')->>'status'='not_enrolled', 'other customer not enrolled');
SELECT t(NOT has_function_privilege('authenticated','commerce_newcomer_enroll(uuid,uuid)','EXECUTE')
  AND NOT has_table_privilege('anon','commerce_newcomer_grant_slots','SELECT'), 'service-role only');
