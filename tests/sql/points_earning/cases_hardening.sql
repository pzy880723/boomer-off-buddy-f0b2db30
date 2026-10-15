\set ON_ERROR_STOP on
-- 接在 cases.sql 之后运行（同库）
CREATE FUNCTION t_conflict(sql text, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE sql; RAISE EXCEPTION 'FAIL %', name;
EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_paid_fact_conflict' THEN RAISE; END IF; RAISE NOTICE 'PASS %', name; END $$;
CREATE FUNCTION t_cnt(k text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM commerce_points_earning_settlements s JOIN commerce_points_earning_orders o ON o.id=s.earning_order_id WHERE o.canonical_key=k $$;
INSERT INTO commerce_customers VALUES ('44444444-4444-4444-8444-444444444444','active');
CREATE FUNCTION t_p4(k text, al text[], src text, fen bigint, pc boolean, at timestamptz, rv text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT commerce_points_record_order_paid(k, al, '44444444-4444-4444-8444-444444444444', src, fen, true, pc, at, rv) $$;
CREATE FUNCTION t_bal4() RETURNS text LANGUAGE sql AS $$
  SELECT points || '/' || points_debt FROM pos_customer_wallets WHERE customer_id='44444444-4444-4444-8444-444444444444' $$;

SELECT t_p4('youzan:H1', ARRAY['erp:h1'], 'youzan', 30000, false, '2026-10-15 01:00+00', 'v1');
SELECT t_assert((t_p4('erp:h1', ARRAY['youzan:H1'], 'erp', 30000, false, '2026-10-15 01:00+00', 'v1')->>'duplicate')::boolean, 'cross-source identical replay is idempotent');
SELECT t_conflict($q$SELECT t_p4('youzan:H1', NULL, 'youzan', 30001, false, '2026-10-15 01:00+00', 'v1')$q$, 'amount change conflicts');
SELECT t_conflict($q$SELECT t_p4('youzan:H1', NULL, 'youzan', 30000, true, '2026-10-15 01:00+00', 'v1')$q$, 'coupon false->true conflicts');
SELECT t_conflict($q$SELECT t_p4('youzan:H1', NULL, 'youzan', 30000, NULL, '2026-10-15 01:00+00', 'v1')$q$, 'coupon unknown on frozen fact conflicts');
SELECT t_conflict($q$SELECT t_p4('youzan:H1', NULL, 'youzan', 30000, false, '2026-10-15 01:00+00', 'v2')$q$, 'rule version change conflicts');
SELECT t_conflict($q$SELECT t_p4('youzan:H1', NULL, 'youzan', 30000, false, '2026-10-15 02:00+00', 'v1')$q$, 'paid_at change conflicts');
SELECT t_p4('erp:h2', NULL, 'erp', 5000, true, '2026-10-15 01:00+00', 'v1');
SELECT t_conflict($q$SELECT t_p4('erp:h2', NULL, 'erp', 5000, false, '2026-10-15 01:00+00', 'v1')$q$, 'coupon true->false conflicts');
SELECT t_assert((SELECT goods_paid_fen=30000 AND rule_version='v1' AND status='earning' AND granted_points=300
  FROM commerce_points_earning_orders WHERE canonical_key='youzan:H1') AND t_bal4()='300/0', 'original fact preserved after conflicts');
DO $$ BEGIN PERFORM commerce_points_record_order_paid('erp:h3', NULL, '44444444-4444-4444-8444-444444444444', NULL, 100, true, false, now(), 'v1');
  RAISE EXCEPTION 'FAIL null source'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_paid_fact_invalid' THEN RAISE; END IF; END $$;
SELECT t_assert(true, 'null source rejected');

-- 欠分审计：花光 → 全额退款只增欠分 → 新赚全部抵债
UPDATE pos_customer_wallets SET points = 0 WHERE customer_id='44444444-4444-4444-8444-444444444444';
SELECT commerce_points_record_order_refund('youzan:H1', NULL, 'h1-r', 30000);
SELECT commerce_points_record_order_refund('youzan:H1', NULL, 'h1-r', 30000);
SELECT t_assert(t_bal4()='0/300' AND t_cnt('youzan:H1')=2 AND (SELECT points_delta=0 AND debt_delta=300 AND delta=-300
  AND points_before=0 AND debt_after=300 AND order_version=2 FROM commerce_points_earning_settlements s JOIN commerce_points_earning_orders o ON o.id=s.earning_order_id
  WHERE o.canonical_key='youzan:H1' ORDER BY order_version DESC LIMIT 1), 'debt-only refund audited once, replay not re-audited');
SELECT t_p4('erp:h4', NULL, 'erp', 20000, false, '2026-10-15 03:00+00', 'v1');
SELECT t_p4('erp:h4', NULL, 'erp', 20000, false, '2026-10-15 03:00+00', 'v1');
SELECT t_assert(t_bal4()='0/100' AND t_cnt('erp:h4')=1 AND (SELECT points_delta=0 AND debt_delta=-200 AND debt_before=300 AND debt_after=100
  FROM commerce_points_earning_settlements s JOIN commerce_points_earning_orders o ON o.id=s.earning_order_id WHERE o.canonical_key='erp:h4')
  AND NOT EXISTS (SELECT 1 FROM commerce_points_ledger WHERE source_id='erp:h4'), 'earning fully repays debt, audited once, no zero ledger row');
SELECT t_assert((SELECT bool_and(points_delta - debt_delta = delta) FROM commerce_points_earning_settlements)
  AND (SELECT count(*) FROM commerce_points_earning_settlements) = (SELECT sum(version) FROM commerce_points_earning_orders), 'every version change has exactly one settlement');
DO $$ BEGIN UPDATE commerce_points_earning_settlements SET delta = delta; RAISE EXCEPTION 'FAIL mutable';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'points_settlement_append_only' THEN RAISE; END IF; END $$;
SELECT t_assert(true, 'settlements append-only');
SELECT t_assert(NOT has_table_privilege('authenticated','commerce_points_earning_settlements','SELECT')
  AND NOT has_table_privilege('anon','commerce_points_earning_settlements','INSERT')
  AND NOT has_table_privilege('authenticated','commerce_points_earning_orders','SELECT')
  AND NOT has_table_privilege('anon','commerce_points_earning_refunds','SELECT')
  AND NOT has_table_privilege('authenticated','commerce_points_earning_order_keys','INSERT'), 'client roles have no table access');
