#!/bin/bash
# 门店自提隔离 SQL 测试（本地临时集群，不连生产库）：bash tests/sql/pickup/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists pickup_test" -c "create database pickup_test" >/dev/null
export PGDB=pickup_test
$PSQL -q -f tests/sql/pickup/stubs.sql >/dev/null
mig=${PICKUP_MIGRATION:-}; [ -n "$mig" ] || mig=$(ls drizzle/migrations/*_store_pickup.sql 2>/dev/null | head -1 || true)
[ -n "$mig" ] || { echo "FAIL store pickup migration missing"; exit 1; }
$PSQL -q -f "$mig" >/dev/null
$PSQL -q -f tests/sql/pickup/cases.sql 2>&1 | grep -o 'PASS .*\|ERROR.*'
bash tests/sql/pickup/concurrency.sh
