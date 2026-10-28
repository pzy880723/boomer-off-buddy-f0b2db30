#!/bin/bash
# 多渠道销售隔离测试：bash tests/sql/sales_channels/run.sh [path/to/0117.sql]
set -euo pipefail
cd "$(dirname "$0")/../../.."
MIG=${1:-$(ls drizzle/migrations/*_sales_channel_intents*.sql | head -1)}
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists saleschannel_test" -c "create database saleschannel_test" >/dev/null 2>&1
export PGDB=saleschannel_test
$PSQL -q -f tests/sql/sales_channels/stubs.sql >/dev/null
# 桩库没有外键目标约束差异：迁移里的 REFERENCES 指向桩表同名主键。
$PSQL -q -v ON_ERROR_STOP=1 -f "$MIG" >/dev/null
$PSQL -q -f tests/sql/sales_channels/cases.sql 2>&1 | grep -o 'PASS .*\|FAIL.*\|ERROR.*'
