#!/bin/bash
# 同城闪送到付 隔离测试（本地临时集群，不连生产库）：bash tests/sql/flash_cod/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${FLASH_COD_MIGRATION:-}; if [ -n "$mig" ] && [ ! -f "$mig" ]; then mig=; fi
[ -n "$mig" ] || mig=$(ls drizzle/migrations/*_flash_cod_delivery.sql 2>/dev/null | head -1)
PGDB=postgres $PSQL -q -c "drop database if exists flash_cod_test" -c "create database flash_cod_test" >/dev/null
export PGDB=flash_cod_test
$PSQL -q -f tests/sql/flash_cod/stubs.sql >/dev/null
if [ -n "$mig" ]; then
  $PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration apply"; exit 1; }
else
  echo "NOTE flash migration absent (RED run)"
fi
out=$($PSQL -q -f tests/sql/flash_cod/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
pass=$(echo "$out" | grep -c 'PASS ')
[ $rc -eq 0 ] && [ "$pass" -eq 21 ] && echo "ALL PASS ($pass)" || { echo "SOME FAILED ($pass/21)"; exit 1; }
