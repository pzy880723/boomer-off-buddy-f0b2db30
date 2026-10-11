#!/bin/bash
# 真实退款生命周期隔离测试：生产结构快照 + 现行函数快照 + 待测迁移；本地临时集群，不连生产库。
#   bash tests/sql/refund_lifecycle/run.sh            # 应用最新修复迁移（GREEN）
#   LIFECYCLE_FIX_MIGRATION= bash ...run.sh           # 仅现行函数（RED）
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh D=tests/sql/refund_lifecycle
PGDB=postgres $PSQL -q -c "drop database if exists refund_lifecycle_test" -c "create database refund_lifecycle_test" >/dev/null
export PGDB=refund_lifecycle_test
for f in $D/prelude.sql $D/live_schema.sql $D/live_functions.sql; do $PSQL -q -f $f >/dev/null || { echo "FAIL load $f"; exit 1; }; done
fix=${LIFECYCLE_FIX_MIGRATION-$(ls drizzle/migrations/*_refund_lifecycle_guard.sql 2>/dev/null | head -1)}
if [ -n "$fix" ]; then $PSQL -q -f "$fix" >/dev/null || { echo "FAIL fix migration"; exit 1; }; else echo "NOTE fix migration absent (RED run)"; fi
$PSQL -q -f $D/fixtures.sql >/dev/null || { echo "FAIL fixtures"; exit 1; }
pass=0; fail=0
for c in $D/cases/*.sql; do
  out=$(psql -h /tmp -p 55432 -U postgres -d $PGDB -q -f "$c" 2>&1)
  p=$(echo "$out" | grep -c 'PASS'); pass=$((pass+p))
  echo "$out" | grep -o 'PASS .*\|ERROR: .*' ; if echo "$out" | grep -q ERROR; then fail=$((fail+1)); fi
done
bash $D/concurrency.sh && pass=$((pass+1)) || fail=$((fail+1))
echo "pass=$pass fail_files=$fail"; [ $fail -eq 0 ]
