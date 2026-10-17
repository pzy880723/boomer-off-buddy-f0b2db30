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
( cd tests/sql/listing_readiness && $PSQL -q -v ON_ERROR_STOP=1 -f stubs.sql >/dev/null && $PSQL -q -v ON_ERROR_STOP=1 < stubs_0076.sql >/dev/null && $PSQL -q -v ON_ERROR_STOP=1 < stubs_0080.sql >/dev/null ) || { echo "FAIL stubs"; exit 1; }
m78=${READINESS_FIX2-$(ls drizzle/migrations/*_listing_readiness_explicit_settle.sql 2>/dev/null | head -1)}
m80=${READINESS_FIX3-$(ls drizzle/migrations/*_listing_readiness_image_plan_display_fix.sql 2>/dev/null | head -1)}
m82=${READINESS_FIX4-$(ls drizzle/migrations/*_listing_readiness_ai_raw_guard.sql 2>/dev/null | head -1)}
m83=${READINESS_FIX5-$(ls drizzle/migrations/*_listing_readiness_reuse_photos_fix.sql 2>/dev/null | head -1)}
mbf=${READINESS_FIX6-$(ls drizzle/migrations/*_product_content_backfill.sql 2>/dev/null | head -1)}
for m in "$m75" "$m76" "$m78" "$m80" $m82 $m83 $mbf; do $PSQL -q -v ON_ERROR_STOP=1 -f "$m" >/dev/null || { echo "FAIL migration $m"; exit 1; }; done
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/listing_readiness/cases.sql -f tests/sql/listing_readiness/cases_0076.sql -f tests/sql/listing_readiness/cases_0080.sql -f tests/sql/listing_readiness/cases_0083.sql -f tests/sql/listing_readiness/cases_backfill.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
n=$(echo "$out" | grep -c 'PASS')
[ $rc -eq 0 ] && [ "$n" -eq 132 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/132)"; exit 1; }
