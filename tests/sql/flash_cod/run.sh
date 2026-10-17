#!/bin/bash
# 同城闪送到付 隔离测试（本地临时集群，不连生产库）：bash tests/sql/flash_cod/run.sh
# 底层 commerce_create_order_v2 用真实库 pg_get_functiondef 导出原文；
# FLASH_V2_PREPATCH=1 换用修复前真实版本做红色验证。
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${FLASH_COD_MIGRATION:-}; if [ -n "$mig" ] && [ ! -f "$mig" ]; then mig=; fi
[ -n "$mig" ] || mig=$(ls drizzle/migrations/*_flash_cod_delivery.sql drizzle/migrations/*_flash_cod_cross_store.sql 2>/dev/null)
PGDB=postgres $PSQL -q -c "drop database if exists flash_cod_test" -c "create database flash_cod_test" >/dev/null
export PGDB=flash_cod_test
stubs=tests/sql/flash_cod/stubs.sql
if [ "${SHIPMENTS_PREPATCH:-}" = "1" ]; then
  sed "s/ARRAY['sf','cainiao','manual','flash']/ARRAY['sf','cainiao','manual']/" "$stubs" > /tmp/flash_cod_stubs_red2.sql
  stubs=/tmp/flash_cod_stubs_red2.sql
fi
if [ "${FLASH_V2_PREPATCH:-}" = "1" ]; then
  sed 's/real_create_order_v2\.sql/real_create_order_v2_prepatch.sql/' "$stubs" > /tmp/flash_cod_stubs_red.sql
  stubs=/tmp/flash_cod_stubs_red.sql
  echo "NOTE using PRE-PATCH real commerce_create_order_v2 (RED run)"
fi
$PSQL -q -f "$stubs" >/dev/null || { echo "FAIL stubs load"; exit 1; }
if [ -n "$mig" ]; then
  $PSQL -q -v ON_ERROR_STOP=1 $(for m in $mig; do echo -f "$m"; done) >/dev/null || { echo "FAIL migration apply"; exit 1; }
else
  echo "NOTE flash migration absent (RED run)"
fi
out=$($PSQL -q -f tests/sql/flash_cod/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
pass=$(echo "$out" | grep -c 'PASS ')
[ $rc -eq 0 ] && [ "$pass" -eq 27 ] && echo "ALL PASS ($pass)" || { echo "SOME FAILED ($pass/27)"; exit 1; }
