#!/bin/bash
# 手工录单号发货 隔离测试（本地临时集群，不连生产库）：bash tests/sql/manual_ship/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${MANUAL_SHIP_MIGRATION:-}; [ -n "$mig" ] || mig=$(ls drizzle/migrations/*_manual_ship_fulfillment.sql 2>/dev/null | head -1)
[ -n "$mig" ] || { echo "FAIL migration missing"; exit 1; }
PGDB=postgres $PSQL -q -c "drop database if exists manual_ship_test" -c "create database manual_ship_test" >/dev/null
export PGDB=manual_ship_test
$PSQL -q -f tests/sql/manual_ship/stubs.sql >/dev/null
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration apply"; exit 1; }
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/manual_ship/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
pass=$(echo "$out" | grep -c PASS)
# 并发：同一子单两个不同 client_op_id 同时登记，只能成功一个
$PSQL -q -c "INSERT INTO commerce_orders VALUES ('00000000-0000-0000-0000-0000000000c1','paid','processing','shipping'); INSERT INTO fulfillments(id,order_id,location_id,status) VALUES ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000000a','picked'); INSERT INTO fulfillment_items(id,fulfillment_id,expected_qty) VALUES ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c2',1);" >/dev/null
call() { $PSQL -qtA -c "SET ROLE service_role; SELECT commerce_manual_ship_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,'00000000-0000-0000-0000-0000000000c2','sf','$1','[{\"fulfillment_item_id\":\"00000000-0000-0000-0000-0000000000c3\",\"quantity\":1}]','$2')->>'result'"; }
call SFC001 op-race-0001 > /tmp/ms_r1 & call SFC002 op-race-0002 > /tmp/ms_r2 & wait
a=$(cat /tmp/ms_r1); b=$(cat /tmp/ms_r2)
cnt=$($PSQL -qtA -c "select count(*)||':'||(select picked_qty from fulfillment_items where id='00000000-0000-0000-0000-0000000000c3') from shipments where fulfillment_id='00000000-0000-0000-0000-0000000000c2'")
if [ "$cnt" = "1:1" ] && { [ "$a$b" = "shippedalready_shipped" ] || [ "$a$b" = "already_shippedshipped" ] || [ "$a$b" = "shippedidempotency_conflict" ] || [ "$a$b" = "idempotency_conflictshipped" ]; }; then echo "PASS concurrent ship once ($a/$b)"; pass=$((pass+1)); else echo "FAIL concurrent ($cnt $a $b)"; rc=1; fi
[ $rc -eq 0 ] && [ "$pass" -eq 3 ] && echo "ALL PASS ($pass)" || { echo "SOME FAILED ($pass/3)"; exit 1; }
