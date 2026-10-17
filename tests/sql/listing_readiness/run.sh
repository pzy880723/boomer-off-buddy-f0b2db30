#!/bin/bash
# 上架准备门禁隔离测试（本地临时集群，不连生产库）：bash tests/sql/listing_readiness/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${READINESS_FUNCS-$(ls drizzle/migrations/*_listing_readiness_gate.sql 2>/dev/null | head -1)}
PGDB=postgres $PSQL -q -c "drop database if exists readiness_test" -c "create database readiness_test" >/dev/null
export PGDB=readiness_test
( cd tests/sql/listing_readiness && $PSQL -q -v ON_ERROR_STOP=1 -f stubs.sql >/dev/null ) || { echo "FAIL stubs"; exit 1; }
if [ -n "$mig" ]; then $PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }; fi
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/listing_readiness/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
n=$(echo "$out" | grep -c 'PASS')
[ $rc -eq 0 ] && [ "$n" -eq 24 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/24)"; exit 1; }
