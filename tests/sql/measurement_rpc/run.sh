#!/bin/bash
# 尺寸测量 RPC 隔离测试（本地临时集群，不连生产库）：bash tests/sql/measurement_rpc/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
migs=$(ls drizzle/migrations/*_measurement_rpc.sql drizzle/migrations/*_measurement_save_conflict_fix.sql 2>/dev/null)
[ -n "$migs" ] || { echo "FAIL migration missing"; exit 1; }
PGDB=postgres $PSQL -q -c "drop database if exists measurement_test" -c "create database measurement_test" >/dev/null
export PGDB=measurement_test
$PSQL -q -f tests/sql/measurement_rpc/stubs.sql >/dev/null
for m in $migs; do
  $PSQL -q -v ON_ERROR_STOP=1 -f "$m" >/dev/null || { echo "FAIL migration apply $m"; exit 1; }
done
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/measurement_rpc/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
out2=$(PSQL=$PSQL bash tests/sql/measurement_rpc/concurrency.sh 2>&1); rc2=$?
echo "$out2" | grep -o 'PASS.*\|FAIL.*\|ERROR.*'
n=$(printf '%s\n%s\n' "$out" "$out2" | grep -c 'PASS')
[ $rc -eq 0 ] && [ $rc2 -eq 0 ] && [ "$n" -eq 10 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/10)"; exit 1; }
