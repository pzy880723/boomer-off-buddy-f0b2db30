#!/bin/bash
# 拍照修图 SLA 调度隔离测试：bash tests/sql/listing_image_sla/run.sh [migration.sql]
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
P=/tmp/psql.sh
PGDB=postgres $P -q -c "drop database if exists listing_sla_test" -c "create database listing_sla_test" >/dev/null 2>&1
export PGDB=listing_sla_test
$P -q -f tests/sql/listing_image_sla/stubs.sql >/dev/null
$P -q -f "${1:-deployments/listing-image-sla-20261013/0059_listing_image_sla.sql}" >/dev/null || { echo "FAIL migration"; exit 1; }
out=$($P -q -f tests/sql/listing_image_sla/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*'
n=$(echo "$out" | grep -c PASS); [ $rc -eq 0 ] && [ "$n" -eq 10 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/10)"; exit 1; }
