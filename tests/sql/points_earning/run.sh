#!/bin/bash
# 隔离库：仅本机临时集群，绝不连生产库。MIGRATION 可覆盖以做 red 测试。
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
P=/tmp/psql.sh; DB=points_earn_test
MIG=${MIGRATION:-$(ls drizzle/migrations/*_points_earning_ledger.sql | tail -1)}
PGDB=postgres $P -c "drop database if exists $DB" -c "create database $DB" >/dev/null
PGDB=$DB $P -q -f tests/sql/points_earning/stubs.sql
PGDB=$DB $P -q -v ON_ERROR_STOP=1 -f "$MIG"
PGDB=$DB $P -q -f tests/sql/points_earning/cases.sql 2>&1 | grep -oE '(PASS|FAIL|ERROR).*'
# 并发：同一单 8 路同时 paid（含有赞别名），只入账一次
PGDB=$DB $P -q -c "insert into commerce_customers values ('33333333-3333-4333-8333-333333333333','active')"
for i in $(seq 1 8); do
  K=$([ $((i%2)) = 0 ] && echo "'youzan:RACE'" || echo "'erp:race'"); A=$([ $((i%2)) = 0 ] && echo "ARRAY['erp:race']" || echo "ARRAY['youzan:RACE']")
  PGDB=$DB $P -q -c "select commerce_points_record_order_paid($K,$A,'33333333-3333-4333-8333-333333333333','erp',99999,true,false,now(),'v1')" >/dev/null 2>/tmp/pe_race_$i.log &
done; wait
# 并发：4 路不同退款 + 2 路重放同时到达
for k in a b c d a b; do
  PGDB=$DB $P -q -c "select commerce_points_record_order_refund('erp:race',NULL,'race-$k',2501)" >/dev/null 2>>/tmp/pe_race_r.log &
done; wait
R=$(PGDB=$DB $P -At -c "select (select points from pos_customer_wallets where customer_id='33333333-3333-4333-8333-333333333333')||'/'||(select count(*) from commerce_points_ledger where customer_id='33333333-3333-4333-8333-333333333333' and source_type='order_earn')||'/'||(select count(*) from commerce_points_earning_orders where canonical_key in ('erp:race','youzan:RACE'))")
# 999.99 - 4×25.01 = 899.95 → 899
if [ "$R" = "899/1/1" ]; then echo "PASS concurrency paid×8 + refund×6 → $R"; else echo "FAIL concurrency $R"; cat /tmp/pe_race_*.log; exit 1; fi
