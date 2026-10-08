#!/bin/bash
# 翻筐乐分筐/赠礼隔离 SQL 测试（本地临时集群，不连生产库）：bash tests/sql/fankuang_basket/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists fankuang_basket_test" -c "create database fankuang_basket_test" >/dev/null
export PGDB=fankuang_basket_test
$PSQL -q -f tests/sql/fankuang_basket/stubs.sql >/dev/null
mig=${FANKUANG_BASKET_MIGRATION:-deployments/fankuang-basket-20261009/0046_fankuang_basket_gifts.sql}
[ -f "$mig" ] || { echo "FAIL candidate migration missing: $mig"; exit 1; }
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/fankuang_basket/cases.sql 2>&1 | grep -o 'PASS .*\|ERROR.*'
