#!/bin/bash
# 隔离库 SQL 测试：重建本地 shortage_test 库（绝不连生产库），加载 stubs + 结构 + 迁移，
# 再逐个跑 cases/ 下的反例，最后跑并发用例。
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL=/tmp/psql.sh

PGDB=postgres $PSQL -c "drop database if exists shortage_test" -c "create database shortage_test" >/dev/null
$PSQL -q -f tests/sql/harness/stubs.sql >/dev/null
$PSQL -q -f /tmp/schema.sql >/tmp/load.log 2>&1 || true
# 结构 dump 已含 0000-0003 的对象，这里只叠加待验证的 0004
for f in tests/sql/0004_*.sql; do $PSQL -q -f "$f" >/dev/null; done
$PSQL -q -f tests/sql/fixtures.sql >/dev/null

fail=0
for c in tests/sql/cases/*.sql; do
  if out=$($PSQL -q -f "$c" 2>&1); then
    echo "$out" | grep -o 'PASS .*' || echo "PASS $(basename "$c")"
  else
    echo "FAIL $(basename "$c")"; echo "$out" | grep -E 'ERROR|FAIL' | head -3; fail=1
  fi
done

# 并发用例：两条同组缺货同时确认，只允许一条拿到运费
bash tests/sql/concurrency/group_freight_race.sh || fail=1
exit $fail
