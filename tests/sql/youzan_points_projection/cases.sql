\set ON_ERROR_STOP on
INSERT INTO commerce_customers VALUES
  ('11111111-1111-4111-8111-111111111111','active'),
  ('22222222-2222-4222-8222-222222222222','active'),
  ('33333333-3333-4333-8333-333333333333','inactive');
-- 本地自主积分 3000（历史测试资产）：投影绝不读取或改写它
INSERT INTO pos_customer_wallets VALUES ('11111111-1111-4111-8111-111111111111', 3000);
CREATE FUNCTION t_assert(ok boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RAISE NOTICE 'PASS %', name; ELSE RAISE EXCEPTION 'FAIL %', name; END IF; END $$;
CREATE FUNCTION t_bal(p_point bigint, p_ver text, p_at text, p_cust uuid DEFAULT '11111111-1111-4111-8111-111111111111', p_yz text DEFAULT 'YZ-A')
RETURNS text LANGUAGE sql AS $$
  SELECT youzan_points_projection_record_balance(p_cust, 100, p_yz, p_point, p_ver, p_at::timestamptz)->>'result' $$;
CREATE FUNCTION t_row() RETURNS record LANGUAGE sql AS $$
  SELECT balance, points_account_version FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111' $$;

-- 1 有赞 0 分写入投影，本地 3000 不变
SELECT t_assert(t_bal(0, '5', '2026-10-15 01:00:00+00') = 'applied', 'youzan zero applied');
SELECT t_assert((SELECT balance FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111') = 0
  AND (SELECT points FROM pos_customer_wallets WHERE customer_id='11111111-1111-4111-8111-111111111111') = 3000, 'youzan 0 shown, local 3000 untouched');

-- 2 新版本覆盖；旧版本（并发慢响应）不能回退
SELECT t_assert(t_bal(120, '7', '2026-10-15 01:05:00+00') = 'applied', 'newer version applied');
SELECT t_assert(t_bal(0, '5', '2026-10-15 01:06:00+00') = 'stale', 'older version stale even if later');
SELECT t_assert((SELECT balance FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111') = 120, 'stale did not overwrite');
SELECT t_assert(t_bal(120, '7', '2026-10-15 01:07:00+00') = 'same_version', 'same version confirms');
SELECT t_assert(t_bal(999, '7', '2026-10-15 01:08:00+00') = 'version_conflict', 'conflict result');
SELECT t_assert((SELECT balance FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111') = 120, 'same version different point rejected');
-- int64 精度
SELECT t_assert(t_bal(121, '9007199254740999', '2026-10-15 01:09:00+00') = 'applied', 'int64 applied');
SELECT t_assert((SELECT points_account_version::text FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111') = '9007199254740999', 'int64 version exact');

-- 3 失败只打标记，保留上次有赞数据；旧失败不覆盖更新的成功
SELECT youzan_points_projection_record_failure('11111111-1111-4111-8111-111111111111','balance','youzan_read_unavailable','2026-10-15 01:10:00+00');
SELECT t_assert((SELECT balance = 121 AND balance_failure = 'youzan_read_unavailable' AND balance_failed_at > balance_synced_at
  FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111'), 'failure keeps last youzan balance');
SELECT youzan_points_projection_record_failure('11111111-1111-4111-8111-111111111111','balance','older_failure','2026-10-15 01:00:00+00');
SELECT t_assert((SELECT balance_failure FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111') = 'youzan_read_unavailable', 'older failure ignored');
-- 失败前的旧请求返回成功：数据接受，但失败时间仍晚于成功时间（状态保持失败）
SELECT t_assert(t_bal(122, '9007199254741000', '2026-10-15 01:09:30+00') = 'applied', 'older success applied');
SELECT t_assert((SELECT balance_failed_at > balance_synced_at FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111'), 'older success does not clear newer failure');
SELECT t_assert(t_bal(122, '9007199254741000', '2026-10-15 01:11:00+00') = 'same_version', 'newer same version');
SELECT t_assert((SELECT balance_synced_at > balance_failed_at FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111'), 'newer success clears failure');
-- 无投影客户的失败：不伪造余额
SELECT youzan_points_projection_record_failure('22222222-2222-4222-8222-222222222222','balance','youzan_read_unavailable',now());
SELECT t_assert((SELECT balance IS NULL AND yz_open_id IS NULL FROM youzan_points_projection WHERE customer_id='22222222-2222-4222-8222-222222222222'), 'failure without data has null balance');

-- 4 身份：映射换人/同一有赞会员被另一顾客占用 → 拒绝
SELECT t_assert(t_bal(5, '9007199254741001', '2026-10-15 01:12:00+00', '11111111-1111-4111-8111-111111111111', 'YZ-OTHER') = 'identity_conflict', 'mapping change rejected');
SELECT t_assert(t_bal(5, '1', '2026-10-15 01:12:00+00', '22222222-2222-4222-8222-222222222222', 'YZ-A') = 'identity_conflict', 'yz member owned by another customer rejected');
SELECT t_assert(t_bal(5, '1', '2026-10-15 01:12:00+00', '33333333-3333-4333-8333-333333333333', 'YZ-C') = 'customer_inactive', 'inactive customer rejected');
DO $$ BEGIN PERFORM youzan_points_projection_record_balance('11111111-1111-4111-8111-111111111111',100,'YZ-A',-1,'99',now());
  RAISE EXCEPTION 'FAIL negative point accepted'; EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'PASS negative point rejected'; END $$;
DO $$ BEGIN PERFORM youzan_points_projection_record_balance('11111111-1111-4111-8111-111111111111',100,'YZ-A',1,'abc',now());
  RAISE EXCEPTION 'FAIL bad version accepted'; EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'PASS bad version rejected'; END $$;

-- 5 官方日志：去重、分页基础、身份校验
SELECT t_assert((youzan_points_projection_record_logs('11111111-1111-4111-8111-111111111111',100,'YZ-A',
  '[{"entry_key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","amount":11,"balance_after":122,"description":"消费送积分","occurred_at":1760490000,"expires_at":null,"biz_value":null},
    {"entry_key":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","amount":-100,"balance_after":111,"description":"积分抵现","occurred_at":1760490100,"expires_at":null,"biz_value":"T1"}]'::jsonb,
  '2026-10-08 00:00:00+00','2026-10-15 01:20:00+00')->>'inserted')::int = 2, 'logs inserted');
SELECT t_assert((youzan_points_projection_record_logs('11111111-1111-4111-8111-111111111111',100,'YZ-A',
  '[{"entry_key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","amount":11,"balance_after":122,"description":"消费送积分","occurred_at":1760490000}]'::jsonb,
  '2026-10-08 00:00:00+00','2026-10-15 01:21:00+00')->>'inserted')::int = 0, 'replay inserted 0');
SELECT t_assert((SELECT count(*) FROM youzan_points_log_entries) = 2, 'log replay dedupe');
SELECT t_assert(youzan_points_projection_record_logs('11111111-1111-4111-8111-111111111111',100,'YZ-OTHER','[]'::jsonb,
  '2026-10-08 00:00:00+00','2026-10-15 01:22:00+00')->>'result' = 'identity_conflict', 'log identity conflict');
SELECT youzan_points_projection_record_failure('11111111-1111-4111-8111-111111111111','log','youzan_read_unavailable','2026-10-15 01:23:00+00');
SELECT t_assert((SELECT log_failed_at > log_synced_at AND balance = 122 FROM youzan_points_projection WHERE customer_id='11111111-1111-4111-8111-111111111111')
  AND (SELECT count(*) FROM youzan_points_log_entries) = 2, 'log failure independent of balance, entries kept');

-- 6 不接触本地自主账本
SELECT t_assert((SELECT points FROM pos_customer_wallets WHERE customer_id='11111111-1111-4111-8111-111111111111') = 3000, 'local wallet still 3000');

-- 7 权限：anon/authenticated 读不到表、调不到函数
SELECT t_assert(NOT has_table_privilege('anon','public.youzan_points_projection','SELECT')
  AND NOT has_table_privilege('authenticated','public.youzan_points_projection','SELECT')
  AND NOT has_table_privilege('authenticated','public.youzan_points_log_entries','SELECT')
  AND NOT has_function_privilege('authenticated','public.youzan_points_projection_record_balance(uuid,bigint,text,bigint,text,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('anon','public.youzan_points_projection_record_logs(uuid,bigint,text,jsonb,timestamptz,timestamptz)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.youzan_points_projection_record_failure(uuid,text,text,timestamptz)','EXECUTE')
  AND has_function_privilege('service_role','public.youzan_points_projection_record_balance(uuid,bigint,text,bigint,text,timestamptz)','EXECUTE'), 'service-only');
