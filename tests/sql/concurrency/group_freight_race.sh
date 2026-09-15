#!/bin/bash
# 事务级并发：同一门店组的两条缺货同时确认，第一条持有支付行锁，
# 第二条必须阻塞并在拿到锁后失败（QUOTE_CHANGED），运费只能被预留一次。
set -uo pipefail
PSQL=/tmp/psql.sh

CTX=$($PSQL -At -c "select public.t_mk_order('race', 4, 100.00, 10.00, 410.00)")
S1=$($PSQL -At -c "select public.t_mk_shortage('$CTX'::jsonb, 0, 10000, 1000, 'v1')")
S2=$($PSQL -At -c "select public.t_mk_shortage('$CTX'::jsonb, 1, 10000, 1000, 'v1')")
CUST=$($PSQL -At -c "select ('$CTX'::jsonb)->>'customer_id'")
ORDER=$($PSQL -At -c "select ('$CTX'::jsonb)->>'order_id'")

$PSQL -At >/tmp/race_a.log 2>&1 <<SQL &
BEGIN;
SELECT public.shortage_confirm_refund_v1('$S1','$CUST','v1','race-a');
SELECT pg_sleep(2);
COMMIT;
SQL
A=$!
sleep 0.7
$PSQL -At >/tmp/race_b.log 2>&1 <<SQL &
BEGIN;
SELECT public.shortage_confirm_refund_v1('$S2','$CUST','v1','race-b');
COMMIT;
SQL
B=$!
wait $A; wait $B

SHIP=$($PSQL -At -c "select coalesce(sum(shipping_fen),0) from public.commerce_refund_intents where order_id='$ORDER'")
CNT=$($PSQL -At -c "select count(*) from public.commerce_refund_intents where order_id='$ORDER'")
if [ "$SHIP" = "1000" ] && [ "$CNT" = "1" ] && grep -q "QUOTE_CHANGED" /tmp/race_b.log; then
  echo "PASS concurrency/group_freight_race (运费预留 ${SHIP} 分，意图 ${CNT} 条)"
  exit 0
fi
echo "FAIL concurrency/group_freight_race: shipping=$SHIP intents=$CNT"
tail -3 /tmp/race_b.log
exit 1
