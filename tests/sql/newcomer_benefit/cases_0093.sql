\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION t(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;

-- 灰度领取：空名单不领、名单外不领、名单内只领该客户
CREATE TEMP TABLE before_other AS SELECT s.id, s.status, s.attempts FROM commerce_newcomer_grant_slots s JOIN commerce_newcomer_grants g ON g.id=s.grant_id WHERE g.customer_id <> 'a0000000-0000-0000-0000-000000000005';
SELECT t((SELECT count(*) FROM commerce_newcomer_claim_scoped(50, 60, ARRAY[]::uuid[])) = 0, 'empty allow-list claims nothing');
SELECT t((SELECT count(*) FROM commerce_newcomer_claim_scoped(50, 60, ARRAY['ffffffff-0000-0000-0000-000000000000']::uuid[])) = 0, 'non-listed customers never claimed');
CREATE TEMP TABLE sc AS SELECT * FROM commerce_newcomer_claim_scoped(50, 60, ARRAY['a0000000-0000-0000-0000-000000000005']::uuid[]);
SELECT t((SELECT count(*) FROM sc) > 0 AND NOT EXISTS (SELECT 1 FROM sc WHERE customer_id <> 'a0000000-0000-0000-0000-000000000005'), 'allow-listed claim only returns that customer');
SELECT t(NOT EXISTS (SELECT 1 FROM before_other b JOIN commerce_newcomer_grant_slots s ON s.id=b.id WHERE s.attempts <> b.attempts OR (s.status <> b.status AND s.last_error IS DISTINCT FROM 'lease_expired_result_unknown')), 'other customers untouched');

-- 灰度补漏：只登记名单内顾客
INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000031','sub-31','18600000031','active'),
  ('a0000000-0000-0000-0000-000000000032','sub-32','18600000032','active');
SELECT t(commerce_newcomer_backfill_scoped(50, ARRAY[]::uuid[]) = 0, 'backfill empty allow-list enrolls nothing');
DELETE FROM commerce_newcomer_grant_slots WHERE grant_id IN (SELECT id FROM commerce_newcomer_grants WHERE customer_id IN
  ('a0000000-0000-0000-0000-000000000031','a0000000-0000-0000-0000-000000000032'));
DELETE FROM commerce_newcomer_grants WHERE customer_id IN ('a0000000-0000-0000-0000-000000000031','a0000000-0000-0000-0000-000000000032');
SELECT t(commerce_newcomer_backfill_scoped(50, ARRAY['a0000000-0000-0000-0000-000000000031']::uuid[]) = 1, 'backfill enrolls the allow-listed customer');
SELECT t(NOT EXISTS (SELECT 1 FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000032'), 'backfill skips customer outside allow-list');

-- 镜像状态：冻结→解冻可恢复；终态不回写；ID 不符不改；每次都刷新同步时间
INSERT INTO pos_customer_coupons (id, customer_id, code, name, discount_type, value, min_spend, status, external_provider, external_id)
VALUES ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000031','YZM1','m','amount',5,49.9,'active','youzan','Y-M1');
CREATE TEMP TABLE r_84241 AS SELECT commerce_youzan_mirror_apply_status('b0000000-0000-0000-0000-000000000001','OTHER','used') r;
SELECT t((SELECT r FROM r_84241)='id_mismatch' AND (SELECT status FROM pos_customer_coupons WHERE id='b0000000-0000-0000-0000-000000000001')='active', 'id mismatch never changes status');
SELECT t((SELECT provider_status_checked_at IS NOT NULL FROM pos_customer_coupons WHERE id='b0000000-0000-0000-0000-000000000001'), 'check stamps sync time for rotation');
CREATE TEMP TABLE r_57717 AS SELECT commerce_youzan_mirror_apply_status('b0000000-0000-0000-0000-000000000001','Y-M1','frozen') r;
SELECT t((SELECT r FROM r_57717)='updated' AND (SELECT status FROM pos_customer_coupons WHERE id='b0000000-0000-0000-0000-000000000001')='frozen', 'frozen mirrored as frozen (not void)');
CREATE TEMP TABLE r_92524 AS SELECT commerce_youzan_mirror_apply_status('b0000000-0000-0000-0000-000000000001','Y-M1','active') r;
SELECT t((SELECT r FROM r_92524)='updated' AND (SELECT status FROM pos_customer_coupons WHERE id='b0000000-0000-0000-0000-000000000001')='active', 'unfrozen coupon returns to active');
SELECT t(commerce_youzan_mirror_apply_status('b0000000-0000-0000-0000-000000000001','Y-M1','used')='updated', 'used applied');
CREATE TEMP TABLE r_72234 AS SELECT commerce_youzan_mirror_apply_status('b0000000-0000-0000-0000-000000000001','Y-M1','active') r;
SELECT t((SELECT r FROM r_72234)='terminal' AND (SELECT status FROM pos_customer_coupons WHERE id='b0000000-0000-0000-0000-000000000001')='used', 'terminal status never rewritten');

SELECT t(NOT has_function_privilege('authenticated','commerce_newcomer_claim_scoped(integer,integer,uuid[])','EXECUTE')
  AND NOT has_function_privilege('authenticated','commerce_newcomer_backfill_scoped(integer,uuid[])','EXECUTE')
  AND NOT has_function_privilege('authenticated','commerce_youzan_mirror_apply_status(uuid,text,text)','EXECUTE'), 'scoped RPCs service-role only');
