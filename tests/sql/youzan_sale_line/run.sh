#!/bin/bash
# 有赞销售行幂等隔离测试（本地临时集群）：bash tests/sql/youzan_sale_line/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists yz_line_test" -c "create database yz_line_test" >/dev/null
export PGDB=yz_line_test
$PSQL -q -f tests/sql/youzan_sale_line/stubs.sql >/dev/null 2>&1 || true
for m in drizzle/migrations/*_commit_youzan_sale_line*.sql; do $PSQL -q -f "$m" >/dev/null; done
$PSQL -q -f tests/sql/youzan_sale_line/cases.sql 2>&1 | grep -o 'PASS .*\|FAIL.*\|ERROR.*'
