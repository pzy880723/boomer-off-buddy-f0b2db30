#!/bin/bash
# 事务级并发（漏退方向）：同组两条缺货都持有 goods-only 旧报价并同时确认。
# 允许最多一条成功；后手必须在拿到支付行锁后被判定为过期报价（QUOTE_CHANGED），
# 而不是静默地把整组运费吞掉。刷新报价后再确认，运费恰好退一次。
set -uo pipefail
PSQL=/tmp/psql.sh

CTX=$($PSQL -At -c "select public.t_mk_order('under-race', 2, 100.00, 10.00, 210.00)")
CUST=$($PSQL -At -c "select ('$CTX'::jsonb)->>'customer_id'")
ORDER=$($PSQL -At -c "select ('$CTX'::jsonb)->>'order_id'")
LOC=$($PSQL -At -c "select ('$CTX'::jsonb)->>'location_id'")
ITEM2=$($PSQL -At -c "select (('$CTX'::jsonb)->'item_ids')->>1")
$PSQL -At -c "update public.commerce_orders set courier_quote_snapshot = jsonb_build_object('groups', jsonb_build_array(jsonb_build_object('location_id','$LOC','shipping_fee_fen',1000))) where id='$ORDER'" >/dev/null

S1=$($PSQL -At -c "select public.t_mk_shortage('$CTX'::jsonb, 0, 10000, 0, 'u1')")
S2=$($PSQL -At -c "select public.t_mk_shortage('$CTX'::jsonb, 1, 10000, 0, 'u2')")

$PSQL -At >/tmp/under_a.log 2>&1 <<SQL &
BEGIN;
SELECT public.shortage_confirm_refund_v1('$S1','$CUST','u1','ua');
SELECT pg_sleep(2);
COMMIT;
SQL
A=$!
sleep 0.7
$PSQL -At >/tmp/under_b.log 2>&1 <<SQL &
BEGIN;
SELECT public.shortage_confirm_refund_v1('$S2','$CUST','u2','ub');
COMMIT;
SQL
B=$!
wait $A; wait $B

if ! grep -q "QUOTE_CHANGED" /tmp/under_b.log; then
  echo "FAIL concurrency/group_freight_no_underrefund: 后手未被判定为过期报价"
  tail -3 /tmp/under_b.log
  exit 1
fi

# 客户重读新版本（含运费）后确认
$PSQL -At -c "select public.shortage_attach_quote_v1('$S2','$CUST','$ITEM2','$LOC', jsonb_build_object('can_confirm',true,'quote_version','u2b','refund_goods_fen',10000,'refund_shipping_fen',1000,'refund_total_fen',11000))" >/dev/null
$PSQL -At -c "select public.shortage_confirm_refund_v1('$S2','$CUST','u2b','ub2')" >/tmp/under_b2.log 2>&1

SHIP=$($PSQL -At -c "select coalesce(sum(shipping_fen),0) from public.commerce_refund_intents where order_id='$ORDER'")
CNT=$($PSQL -At -c "select count(*) from public.commerce_refund_intents where order_id='$ORDER'")
if [ "$SHIP" = "1000" ] && [ "$CNT" = "2" ]; then
  echo "PASS concurrency/group_freight_no_underrefund (运费退 ${SHIP} 分，意图 ${CNT} 条)"
  exit 0
fi
echo "FAIL concurrency/group_freight_no_underrefund: shipping=$SHIP intents=$CNT"
tail -3 /tmp/under_b2.log
exit 1
