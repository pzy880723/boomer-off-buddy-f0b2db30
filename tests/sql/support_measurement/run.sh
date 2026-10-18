#!/bin/bash
# 尺寸申请走客服会话 + 首页待处理聚合 隔离测试（本地临时集群，不连生产库）：bash tests/sql/support_measurement/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists support_measurement_test" -c "create database support_measurement_test" >/dev/null
export PGDB=support_measurement_test
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/support_measurement/stubs.sql >/dev/null || { echo "FAIL stubs"; exit 1; }
mig=${SUPPORT_MEASUREMENT_MIGRATION-$(ls drizzle/migrations/*_support_measurement_cards.sql 2>/dev/null | head -1)}
if [ -n "$mig" ]; then $PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }; else echo "NOTE migration absent (RED run)"; fi
out=$($PSQL -q -f tests/sql/support_measurement/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*'
n=$(echo "$out" | grep -c PASS); [ $rc -eq 0 ] && [ "$n" -eq 8 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/8)"; exit 1; }
