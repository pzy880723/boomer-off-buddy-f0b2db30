#!/bin/bash
# 并发：退款成功回调（现行 apply，锁 订单→支付→退款）与手工发货（锁 订单→子单）同时进行，不得死锁；
# 发货要么在退款前成功、要么看到退款事实后按规则处理。用 S14：两件，一件缺货已确认待退款。
set -uo pipefail
P="psql -h /tmp -p 55432 -U postgres -d ${PGDB:-refund_lifecycle_test} -qtA"
$P -c "SELECT t_order('o14','shipping',20); SELECT t_ful('f14','o14','A','picked'); SELECT t_item('i141','f14',1,1); SELECT t_item('i142','f14',1,0); SELECT t_shortage('s14','o14','f14','i142',1,1000); SELECT t_claim('s14');" >/dev/null
( $P -c "BEGIN; SELECT t_refund_apply('s14:rf','o14','s14:as',10); SELECT pg_sleep(1); SELECT t_settle('s14','succeeded','s14:rf'); COMMIT;" >/tmp/rl_a 2>&1 ) &
sleep 0.3
b=$($P -c "SET lock_timeout='10s'; SELECT t_ship('f14', jsonb_build_array(t_line('i141',1)), 'k-s14')->>'result'" 2>&1); wait
a=$(cat /tmp/rl_a)
if echo "$a$b" | grep -qi deadlock; then echo "FAIL concurrency deadlock"; exit 1; fi
c=$($P -c "SELECT t_ship('f14', jsonb_build_array(t_line('i141',1)), 'k-s14b')->>'result'")
n=$($P -c "select count(*) from shipments where fulfillment_id=t_id('f14')")
p=$($P -c "select picked_qty from fulfillment_items where id=t_id('i142')")
# 发货在订单锁上等待退款事务提交：要么先看到 processing 被阻断后再登记成功，要么等到清算后直接成功；
# 无死锁、仅 1 条运单、缺货行未被计入拣货。
if { { [ "$b" = "refund_blocked" ] && [ "$c" = "shipped" ]; } || { [ "$b" = "shipped" ] && [ "$c" = "already_shipped" ]; }; } && [ "$n" = "1" ] && [ "$p" = "0" ]; then
  echo "PASS concurrency refund-callback vs ship: no deadlock, ship only after settlement ($b/$c)"; exit 0; fi
echo "FAIL concurrency b=$b c=$c n=$n a=$(echo $a | tail -c 200)"; exit 1
