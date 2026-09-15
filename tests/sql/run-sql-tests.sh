#!/bin/bash
# 隔离库 SQL 测试：在本地临时 PostgreSQL 集群里重建 shortage_test 库（绝不连生产库），
# 加载 stubs + 结构（tests/sql/harness/schema.sql，仅结构）+ 缺货相关迁移，
# 再逐个跑 cases/ 下的反例，最后跑并发用例。
#
#   bash tests/sql/run-sql-tests.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

bash tests/sql/harness/setup.sh >/dev/null
PSQL=/tmp/psql.sh

PGDB=postgres $PSQL -c "drop database if exists shortage_test" -c "create database shortage_test" >/dev/null
$PSQL -q -f tests/sql/harness/stubs.sql >/dev/null
$PSQL -q -f tests/sql/harness/schema.sql >/tmp/load.log 2>&1 || true
# 结构 dump 只含表；缺货相关函数由迁移按序加载
for f in drizzle/migrations/0003_*.sql drizzle/migrations/0004_*.sql drizzle/migrations/0005_*.sql; do
  [ -f "$f" ] && $PSQL -q -f "$f" >/dev/null
done
$PSQL -q -f tests/sql/fixtures.sql >/dev/null

fail=0
for c in tests/sql/cases/*.sql; do
  if out=$($PSQL -q -f "$c" 2>&1); then
    echo "$out" | grep -o 'PASS .*' || echo "PASS $(basename "$c")"
  else
    echo "FAIL $(basename "$c")"; echo "$out" | grep -E 'ERROR|FAIL' | head -3; fail=1
  fi
done

# 并发用例：同组缺货同时确认，运费只能被退一次、且不得漏退
bash tests/sql/concurrency/group_freight_race.sh || fail=1
bash tests/sql/concurrency/group_freight_no_underrefund.sh || fail=1
exit $fail
