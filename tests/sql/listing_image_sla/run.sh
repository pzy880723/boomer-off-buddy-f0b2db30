#!/bin/bash
# 拍照修图 SLA 调度隔离测试：bash tests/sql/listing_image_sla/run.sh [migration.sql]
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
P=/tmp/psql.sh
PGDB=postgres $P -q -c "drop database if exists listing_sla_test" -c "create database listing_sla_test" >/dev/null 2>&1
export PGDB=listing_sla_test
$P -q -f tests/sql/listing_image_sla/stubs.sql >/dev/null
$P -q -c "do \$\$ begin create role anon; exception when duplicate_object then null; end \$\$" -c "do \$\$ begin create role authenticated; exception when duplicate_object then null; end \$\$" -c "do \$\$ begin create role service_role; exception when duplicate_object then null; end \$\$" >/dev/null 2>&1
for m in ${1:-drizzle/migrations/0059_listing_image_sla.sql drizzle/migrations/0060_listing_image_sla_no_kill.sql}; do $P -q -f "$m" >/dev/null || { echo "FAIL migration $m"; exit 1; }; done
out=$($P -q -f tests/sql/listing_image_sla/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*'
n=$(echo "$out" | grep -c PASS); [ $rc -eq 0 ] && [ "$n" -eq 12 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/12)"; exit 1; }
