\set ON_ERROR_STOP on
INSERT INTO commerce_customers VALUES ('11111111-1111-4111-8111-111111111111','active'),('22222222-2222-4222-8222-222222222222','inactive');
CREATE FUNCTION t_paid(k text, aliases text[], fen bigint, complete boolean, pc boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT commerce_points_record_order_paid(k, aliases, '11111111-1111-4111-8111-111111111111', split_part(k, ':', 1), fen, complete, pc, now(), 'paid_goods_1yuan_1pt_v1') $$;
CREATE FUNCTION t_bal() RETURNS text LANGUAGE sql AS $$
  SELECT points || '/' || points_debt FROM pos_customer_wallets WHERE customer_id='11111111-1111-4111-8111-111111111111' $$;
CREATE FUNCTION t_assert(ok boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RAISE NOTICE 'PASS %', name; ELSE RAISE EXCEPTION 'FAIL %', name; END IF; END $$;

-- 1 开关关闭：零写入
SELECT t_assert(t_paid('erp:o1', NULL, 12345, true, false)->>'status' = 'disabled'
  AND (SELECT count(*) FROM commerce_points_earning_orders) = 0 AND (SELECT count(*) FROM commerce_points_ledger) = 0, 'flag off writes nothing');
INSERT INTO app_settings VALUES ('points_earning_enabled','true');

-- 2 绑定会员 + 真实支付：123.45元 → 123分；重放只一次
SELECT t_assert((t_paid('erp:o1', NULL, 12345, true, false)->>'granted_points')::int = 123 AND t_bal() = '123/0', 'paid earns floor(fen/100)');
SELECT t_assert((t_paid('erp:o1', NULL, 12345, true, false)->>'duplicate')::boolean AND t_bal() = '123/0', 'replay paid once');

-- 3 canonical 去重：有赞导入ERP的同一单
SELECT t_paid('youzan:T100', ARRAY['erp:o2'], 5000, true, false);
SELECT t_assert((t_paid('erp:o2', ARRAY['youzan:T100'], 5000, true, false)->>'duplicate')::boolean AND t_bal() = '173/0', 'alias dedupe youzan import');

-- 4 累计部分退款按累计净额：100.99元 退 0.50 ×2 → 净 99.99 → 99分（逐次舍入不会出现 100）
SELECT t_paid('erp:o3', NULL, 10099, true, false);
SELECT commerce_points_record_order_refund('erp:o3', NULL, 'r3a', 50);
SELECT commerce_points_record_order_refund('erp:o3', NULL, 'r3a', 50);
SELECT commerce_points_record_order_refund('erp:o3', NULL, 'r3b', 50);
SELECT t_assert((SELECT granted_points FROM commerce_points_earning_orders WHERE canonical_key='erp:o3') = 99, 'cumulative refund net floor + refund replay');

-- 5 退款先到、付款后到
SELECT t_assert(commerce_points_record_order_refund('youzan:T200', NULL, 'r200', 3000)->>'status' = 'awaiting_paid', 'refund before paid parked');
SELECT t_assert((t_paid('youzan:T200', NULL, 8000, true, false)->>'granted_points')::int = 50, 'out-of-order refund applied on paid');

-- 6 优惠明细不完整暂挂；补齐后入账
SELECT t_paid('erp:o4', NULL, 4000, false, NULL);
SELECT t_assert( (SELECT granted_points FROM commerce_points_earning_orders WHERE canonical_key='erp:o4') = 0, 'incomplete discount detail holds');
SELECT t_assert((t_paid('erp:o4', NULL, 4000, true, false)->>'granted_points')::int = 40, 'hold resolves with complete detail');

-- 7 积分兑换券：整单 0 分（含现金补付）；之后不能被改回赚分
SELECT t_paid('erp:o5', NULL, 20000, true, true);
SELECT t_assert( (SELECT granted_points FROM commerce_points_earning_orders WHERE canonical_key='erp:o5') = 0, 'points coupon order earns 0');
SELECT t_paid('erp:o5', NULL, 20000, true, false);
SELECT t_assert( (SELECT granted_points FROM commerce_points_earning_orders WHERE canonical_key='erp:o5') = 0, 'points coupon order not re-earnable');

-- 8 先花掉积分再退款 → 负积分债务；新入账先还债
UPDATE pos_customer_wallets SET points = 10 WHERE customer_id='11111111-1111-4111-8111-111111111111';
SELECT commerce_points_record_order_refund('erp:o1', NULL, 'r1', 12345);
SELECT t_assert(t_bal() = '0/113', 'spent then refunded becomes debt');
SELECT t_paid('erp:o6', NULL, 20000, true, false);
SELECT t_assert(t_bal() = '87/0', 'new earning repays debt first');

-- 9 失败封闭：停用会员、客户错配、别名冲突、退款键复用不同金额
DO $$ BEGIN PERFORM commerce_points_record_order_paid('erp:o7', NULL, '22222222-2222-4222-8222-222222222222','erp',100,true,false,now(),'v1');
  RAISE EXCEPTION 'FAIL inactive'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_customer_inactive' THEN RAISE; END IF; END $$;
UPDATE commerce_customers SET status='active' WHERE id='22222222-2222-4222-8222-222222222222';
DO $$ BEGIN PERFORM commerce_points_record_order_paid('erp:o6', NULL, '22222222-2222-4222-8222-222222222222','erp',100,true,false,now(),'v1');
  RAISE EXCEPTION 'FAIL mismatch'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_customer_mismatch' THEN RAISE; END IF; END $$;
DO $$ BEGIN PERFORM t_paid('erp:o1', ARRAY['erp:o6'], 1, true, false);
  RAISE EXCEPTION 'FAIL alias'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_order_alias_conflict' THEN RAISE; END IF; END $$;
DO $$ BEGIN PERFORM commerce_points_record_order_refund('erp:o3', NULL, 'r3a', 51);
  RAISE EXCEPTION 'FAIL refund key'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_refund_key_conflict' THEN RAISE; END IF; END $$;
SELECT t_assert(true, 'fail-closed: inactive/mismatch/alias/refund-key conflicts');

-- 10 账本与钱包一致；客户端角色无执行权
SELECT t_assert((SELECT balance_after FROM commerce_points_ledger ORDER BY created_at DESC, delta DESC LIMIT 1) = (SELECT points FROM pos_customer_wallets WHERE customer_id='11111111-1111-4111-8111-111111111111'), 'ledger balance matches wallet');
SELECT t_assert(NOT has_function_privilege('authenticated','commerce_points_record_order_paid(text,text[],uuid,text,bigint,boolean,boolean,timestamptz,text)','EXECUTE')
  AND NOT has_function_privilege('anon','commerce_points_record_order_refund(text,text[],text,bigint)','EXECUTE')
  AND has_function_privilege('service_role','commerce_points_record_order_paid(text,text[],uuid,text,bigint,boolean,boolean,timestamptz,text)','EXECUTE')
  AND NOT has_table_privilege('authenticated','commerce_points_earning_orders','SELECT'), 'service_role only');
