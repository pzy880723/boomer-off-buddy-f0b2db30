#!/bin/bash
# 隔离库：仅本机临时集群，绝不连生产库。MIGRATIONS 可覆盖以做 red 测试。
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
P=/tmp/psql.sh; DB=yz_points_proj_test
MIGS=${MIGRATIONS-$(ls drizzle/migrations/*_youzan_points_projection*.sql 2>/dev/null || true)}
PGDB=postgres $P -c "drop database if exists $DB" -c "create database $DB" >/dev/null
PGDB=$DB $P -q -f tests/sql/youzan_points_projection/stubs.sql
for m in $MIGS; do PGDB=$DB $P -q -v ON_ERROR_STOP=1 -f "$m"; done
PGDB=$DB $P -q -f tests/sql/youzan_points_projection/cases.sql 2>&1 | grep -oE '(PASS|FAIL|ERROR).*'
# 并发：同一顾客 8 路同时写入不同版本 → 最终必须是最高版本
PGDB=$DB $P -q -c "insert into commerce_customers values ('44444444-4444-4444-8444-444444444444','active')"
for v in 3 8 1 6 2 7 4 5; do
  PGDB=$DB $P -q -c "select youzan_points_projection_record_balance('44444444-4444-4444-8444-444444444444',100,'YZ-RACE',$v*10,'$v',now())" >/dev/null 2>>/tmp/yzp_race.log &
done; wait
R=$(PGDB=$DB $P -At -c "select balance||'/'||points_account_version from youzan_points_projection where customer_id='44444444-4444-4444-8444-444444444444'")
if [ "$R" = "80/8" ]; then echo "PASS concurrency 8 versions → $R"; else echo "FAIL concurrency $R"; cat /tmp/yzp_race.log; exit 1; fi
