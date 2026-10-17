#!/bin/bash
# 上架准备门禁隔离测试（本地临时集群，不连生产库）：bash tests/sql/listing_readiness/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
m75=$(ls drizzle/migrations/*_listing_readiness_gate.sql | head -1)
m76=${READINESS_FIX-$(ls drizzle/migrations/*_listing_readiness_fail_closed_functions.sql 2>/dev/null | head -1)}
PGDB=postgres $PSQL -q -c "drop database if exists readiness_test" -c "create database readiness_test" >/dev/null
export PGDB=readiness_test
( cd tests/sql/listing_readiness && $PSQL -q -v ON_ERROR_STOP=1 -f stubs.sql >/dev/null && $PSQL -q -v ON_ERROR_STOP=1 < stubs_0076.sql >/dev/null ) || { echo "FAIL stubs"; exit 1; }
m78=${READINESS_FIX2-$(ls drizzle/migrations/*_listing_readiness_explicit_settle.sql 2>/dev/null | head -1)}
for m in "$m75" "$m76" "$m78"; do $PSQL -q -v ON_ERROR_STOP=1 -f "$m" >/dev/null || { echo "FAIL migration $m"; exit 1; }; done
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/listing_readiness/cases.sql -f tests/sql/listing_readiness/cases_0076.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
n=$(echo "$out" | grep -c 'PASS')
[ $rc -eq 0 ] && [ "$n" -eq 58 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/58)"; exit 1; }
