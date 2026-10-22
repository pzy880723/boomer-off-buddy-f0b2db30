#!/bin/bash
# 手持待办/通知整改隔离回归（本地临时集群，不连生产库）：bash tests/sql/handheld_work_items/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists handheld_work_items_test" -c "create database handheld_work_items_test" >/dev/null
export PGDB=handheld_work_items_test
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/handheld_work_items/stubs.sql >/dev/null || { echo "FAIL stubs"; exit 1; }
for mig in drizzle/migrations/0097_support_measurement_safe_work_items.sql \
           drizzle/migrations/0098_support_work_items_hq_unlocated.sql \
           drizzle/migrations/0099_handheld_todo_notification_fixes.sql \
           drizzle/migrations/0100_handheld_sync_recovery_masking_workitems_ignore.sql; do
  $PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL $mig"; exit 1; }
done
# 0101 投影修复：优先用已落地的 drizzle 迁移，否则用本目录逐字副本（迁移未落地前的 RED/GREEN 验证）。
fix=$(ls drizzle/migrations/0101_*min_uuid*.sql 2>/dev/null | head -1)
fix=${fix:-tests/sql/handheld_work_items/projection_fix.sql}
$PSQL -q -v ON_ERROR_STOP=1 -f "$fix" >/dev/null || { echo "FAIL projection fix"; exit 1; }
# scoped 基线：腾讯生产 20261018171531_measurement_support_scope.sql 的逐字副本（真实线上路径）。
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/handheld_work_items/scoped_baseline.sql >/dev/null || { echo "FAIL scoped baseline"; exit 1; }
# 0102 scoped 对齐：优先用已落地的 drizzle 迁移，否则用本目录逐字副本。
scoped=$(ls drizzle/migrations/0102_*scoped_work_items*.sql 2>/dev/null | head -1)
scoped=${scoped:-tests/sql/handheld_work_items/scoped_ignore.sql}
$PSQL -q -v ON_ERROR_STOP=1 -f "$scoped" >/dev/null || { echo "FAIL scoped ignore migration"; exit 1; }
# 0103 投影 recovered 复位：优先用已落地的 drizzle 迁移，否则用本目录逐字副本。
reset=$(ls drizzle/migrations/0103_*recovered_reset*.sql 2>/dev/null | head -1)
reset=${reset:-tests/sql/handheld_work_items/projection_recovered_reset.sql}
$PSQL -q -v ON_ERROR_STOP=1 -f "$reset" >/dev/null || { echo "FAIL recovered reset migration"; exit 1; }
out=$($PSQL -q -f tests/sql/handheld_work_items/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS [0-9]* .*\|ERROR.*\|ASSERT.*'
n1=$(echo "$out" | grep -c 'PASS '); [ $rc -eq 0 ] && [ "$n1" -eq 19 ] || { echo "SOME FAILED ($n1/19)"; exit 1; }
out=$($PSQL -q -f tests/sql/support_measurement/support-scope.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|ASSERT.*'
n2=$(echo "$out" | grep -c 'PASS '); [ $rc -eq 0 ] && [ "$n2" -eq 1 ] || { echo "SOME FAILED support-scope"; exit 1; }
out=$($PSQL -q -f tests/sql/handheld_work_items/scoped_cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS S[0-9]* .*\|ERROR.*\|ASSERT.*'
n3=$(echo "$out" | grep -c 'PASS '); [ $rc -eq 0 ] && [ "$n3" -eq 9 ] || { echo "SOME FAILED scoped ($n3/9)"; exit 1; }
echo "ALL PASS ($((n1+n2+n3)))"
