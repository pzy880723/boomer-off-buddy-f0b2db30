#!/bin/bash
# 手持未读角标计数隔离测试（本地临时集群）：bash tests/sql/unread_counts/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists unread_counts_test" -c "create database unread_counts_test" >/dev/null
export PGDB=unread_counts_test
$PSQL -q -f tests/sql/unread_counts/stubs.sql >/dev/null
mig=${UNREAD_MIGRATION-$(ls drizzle/migrations/*_handheld_unread_counts.sql 2>/dev/null | head -1)}
[ -n "$mig" ] && { $PSQL -q -f "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }; } || echo "NOTE migration absent (RED run)"
out=$($PSQL -q -f tests/sql/unread_counts/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*'
n=$(echo "$out" | grep -c PASS); [ $rc -eq 0 ] && [ "$n" -eq 4 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/4)"; exit 1; }
