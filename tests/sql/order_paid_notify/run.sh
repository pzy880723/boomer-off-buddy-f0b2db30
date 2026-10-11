#!/bin/bash
# 已付款订单→门店手持提醒 隔离测试（本地临时集群，不连生产库）：bash tests/sql/order_paid_notify/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${ORDER_PAID_MIGRATION:-}; [ -n "$mig" ] || mig=$(ls drizzle/migrations/*_order_paid_handheld_notify.sql 2>/dev/null | head -1)
[ -n "$mig" ] || { echo "FAIL migration missing"; exit 1; }
PGDB=postgres $PSQL -q -c "drop database if exists order_paid_test" -c "create database order_paid_test" >/dev/null
export PGDB=order_paid_test
$PSQL -q -f tests/sql/order_paid_notify/stubs.sql >/dev/null
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration apply"; exit 1; }
mig2=${RELIABILITY_MIGRATION-$(ls drizzle/migrations/*_handheld_notify_reliability_v2.sql 2>/dev/null | head -1)}
if [ -n "$mig2" ]; then $PSQL -q -v ON_ERROR_STOP=1 -f "$mig2" >/dev/null || { echo "FAIL reliability migration apply"; exit 1; }; else echo "NOTE reliability migration absent (RED run)"; fi
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/order_paid_notify/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
out2=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/order_paid_notify/reliability.sql 2>&1); rc2=$?
echo "$out2" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
out3=$(PSQL=$PSQL bash tests/sql/order_paid_notify/late_commit.sh 2>&1); rc3=$?; echo "$out3" | grep -o 'PASS.*\|FAIL.*\|ERROR.*'
n=$(printf '%s\n%s\n%s\n' "$out" "$out2" "$out3" | grep -c 'PASS')
[ $rc -eq 0 ] && [ $rc2 -eq 0 ] && [ $rc3 -eq 0 ] && [ "$n" -eq 11 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/11)"; exit 1; }
