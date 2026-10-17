#!/bin/bash
# 尺寸测量 RPC 隔离测试（本地临时集群，不连生产库）：bash tests/sql/measurement_rpc/run.sh
# 表结构 = real_schema.sql（实际库 0070 后状态的只读裁剪）；只叠加纠错迁移。
# RED 复现：MEASUREMENT_FUNCS=<文件> 用指定函数定义（如实际库导出的旧函数）代替纠错迁移。
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${MEASUREMENT_FUNCS:-$(ls drizzle/migrations/*_measurement_stock_location_fix.sql 2>/dev/null | head -1)}
[ -n "$mig" ] || { echo "FAIL migration missing"; exit 1; }
PGDB=postgres $PSQL -q -c "drop database if exists measurement_test" -c "create database measurement_test" >/dev/null
export PGDB=measurement_test
( cd tests/sql/measurement_rpc && $PSQL -q -v ON_ERROR_STOP=1 -f stubs.sql >/dev/null ) || { echo "FAIL stubs"; exit 1; }
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration apply $mig"; exit 1; }
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/measurement_rpc/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
out2=$(PSQL=$PSQL bash tests/sql/measurement_rpc/concurrency.sh 2>&1); rc2=$?
echo "$out2" | grep -o 'PASS.*\|FAIL.*\|ERROR.*'
n=$(printf '%s\n%s\n' "$out" "$out2" | grep -c 'PASS')
[ $rc -eq 0 ] && [ $rc2 -eq 0 ] && [ "$n" -eq 18 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/18)"; exit 1; }
