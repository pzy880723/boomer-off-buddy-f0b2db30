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
mig2=${MANUAL_SHIP_V2_MIGRATION-$(ls drizzle/migrations/*_manual_ship_reliability.sql 2>/dev/null | head -1)}
if [ -n "$mig2" ]; then $PSQL -q -v ON_ERROR_STOP=1 -f "$mig2" >/dev/null || { echo "FAIL v2 migration apply"; exit 1; }; else echo "NOTE v2 migration absent (RED run)"; fi
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/manual_ship/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
pass=$(echo "$out" | grep -c PASS)
for f in cases_reliability cases_v2; do o=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/manual_ship/$f.sql 2>&1) || rc=1; echo "$o" | grep -o 'PASS .*\|ERROR.*'; pass=$((pass+$(echo "$o" | grep -c PASS))); done
# 并发：同一子单两个不同 client_op_id 同时登记，只能成功一个
$PSQL -q -c "INSERT INTO commerce_orders VALUES ('00000000-0000-0000-0000-0000000000c1','paid','processing','shipping'); INSERT INTO fulfillments(id,order_id,location_id,status) VALUES ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000000a','picked'); INSERT INTO fulfillment_items(id,fulfillment_id,expected_qty) VALUES ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c2',1);" >/dev/null
# 并发重放：同 key 同内容两请求同时到达 → 一个 shipped、一个 replayed，仅 1 条运单
$PSQL -q -c "INSERT INTO commerce_orders VALUES ('00000000-0000-0000-0000-0000000000d1','paid','processing','shipping'); INSERT INTO fulfillments(id,order_id,location_id,status) VALUES ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-00000000000a','picked'); INSERT INTO fulfillment_items(id,fulfillment_id,expected_qty,picked_qty) VALUES ('00000000-0000-0000-0000-0000000000d3','00000000-0000-0000-0000-0000000000d2',1,1);" >/dev/null
rcall() { $PSQL -qtA -c "SET ROLE service_role; SELECT (r->>'result')||':'||coalesce(r->>'replayed','') FROM commerce_manual_ship_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,'00000000-0000-0000-0000-0000000000d2','manual','ZTR001','[{\"fulfillment_item_id\":\"00000000-0000-0000-0000-0000000000d3\",\"quantity\":1}]','op-same-key','中通快递') r"; }
if $PSQL -qtA -c "select 1 from pg_proc where proname='commerce_manual_ship_fulfillment' and pronargs=8" | grep -q 1; then
rcall > /tmp/ms_s1 & rcall > /tmp/ms_s2 & wait
x="$(cat /tmp/ms_s1) $(cat /tmp/ms_s2)"; c2=$($PSQL -qtA -c "select count(*)||':'||(select picked_qty from fulfillment_items where id='00000000-0000-0000-0000-0000000000d3') from shipments where fulfillment_id='00000000-0000-0000-0000-0000000000d2'")
case "$x" in "shipped:false shipped:true"|"shipped:true shipped:false") [ "$c2" = "1:1" ] && { echo "PASS concurrent same-key replay ($x)"; pass=$((pass+1)); } || { echo "FAIL same-key ($c2)"; rc=1; };; *) echo "FAIL same-key ($x)"; rc=1;; esac
else echo "FAIL same-key (v2 absent)"; rc=1; fi
call() { $PSQL -qtA -c "SET ROLE service_role; SELECT commerce_manual_ship_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,'00000000-0000-0000-0000-0000000000c2','sf','$1','[{\"fulfillment_item_id\":\"00000000-0000-0000-0000-0000000000c3\",\"quantity\":1}]','$2')->>'result'"; }
call SFC001 op-race-0001 > /tmp/ms_r1 & call SFC002 op-race-0002 > /tmp/ms_r2 & wait
a=$(cat /tmp/ms_r1); b=$(cat /tmp/ms_r2)
cnt=$($PSQL -qtA -c "select count(*)||':'||(select picked_qty from fulfillment_items where id='00000000-0000-0000-0000-0000000000c3') from shipments where fulfillment_id='00000000-0000-0000-0000-0000000000c2'")
if [ "$cnt" = "1:1" ] && { [ "$a$b" = "shippedalready_shipped" ] || [ "$a$b" = "already_shippedshipped" ] || [ "$a$b" = "shippedidempotency_conflict" ] || [ "$a$b" = "idempotency_conflictshipped" ]; }; then echo "PASS concurrent ship once ($a/$b)"; pass=$((pass+1)); else echo "FAIL concurrent ($cnt $a $b)"; rc=1; fi
[ $rc -eq 0 ] && [ "$pass" -eq 8 ] && echo "ALL PASS ($pass)" || { echo "SOME FAILED ($pass/8)"; exit 1; }
