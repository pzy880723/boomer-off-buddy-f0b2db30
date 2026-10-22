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
out=$($PSQL -q -f tests/sql/handheld_work_items/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS [0-9]* .*\|ERROR.*\|ASSERT.*'
n=$(echo "$out" | grep -c 'PASS '); [ $rc -eq 0 ] && [ "$n" -eq 17 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/17)"; exit 1; }
