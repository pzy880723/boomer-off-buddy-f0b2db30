#!/bin/bash
# 翻筐乐分筐/赠礼隔离 SQL 测试（本地临时集群，不连生产库）：bash tests/sql/fankuang_basket/run.sh
# 每个用例文件使用独立的新库：cases.sql（基础行为）、cases_review_20261008.sql（6b7d8feb 复核回归）。
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${FANKUANG_BASKET_MIGRATION:-deployments/fankuang-basket-20261009/0046_fankuang_basket_gifts.sql}
[ -f "$mig" ] || { echo "FAIL candidate migration missing: $mig"; exit 1; }
fail=0
for cases in tests/sql/fankuang_basket/cases.sql tests/sql/fankuang_basket/cases_review_20261008.sql; do
  PGDB=postgres $PSQL -q -c "drop database if exists fankuang_basket_test" -c "create database fankuang_basket_test" >/dev/null
  export PGDB=fankuang_basket_test
  $PSQL -q -f tests/sql/fankuang_basket/stubs.sql >/dev/null
  $PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null 2>&1 || { echo "FAIL migration apply"; exit 1; }
  echo "== $cases"
  out=$($PSQL -q -v ON_ERROR_STOP=1 -f "$cases" 2>&1); rc=$?
  echo "$out" | grep -o 'PASS .*\|ERROR.*'
  [ $rc -eq 0 ] || fail=1
done
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
