#!/bin/bash
# 并发：同一凭证两个员工同时核销只成功一次；同店 40 单并发付款四位码唯一；退款与核销竞态。
set -euo pipefail
P="${PSQL:-/tmp/psql.sh}"
A=a0000000-0000-4000-8000-000000000001
SA=b0000000-0000-4000-8000-00000000000a
SE=b0000000-0000-4000-8000-00000000000e
fail=0
# 1 并发付款发码唯一
for i in $(seq 1 40); do
  $P -qAt -c "with o as (insert into commerce_orders(fulfillment_method) values ('pickup') returning id) select test_mark_paid(id, array['$A']::uuid[]) from o" >/dev/null &
done
wait
dup=$($P -qAt -c "select count(*) from (select code from commerce_pickup_codes where location_id='$A' and status='active' group by code having count(*)>1) d")
[ "$dup" = "0" ] && echo "PASS concurrent issuance unique codes" || { echo "FAIL duplicate codes $dup"; fail=1; }
# 2 双人同时核销同一凭证
row=$($P -qAt -F' ' -c "select qr_token, fulfillment_id from commerce_pickup_codes where location_id='$A' and status='active' limit 1")
tok=${row% *}; fid=${row#* }
$P -qAt -c "select commerce_pickup_mark_ready('$SA','$A','$fid','race-ready-1')" >/dev/null
r1=$(mktemp); r2=$(mktemp)
$P -qAt -c "select commerce_pickup_redeem('$SA','$A','BOOMER_PICKUP:$tok',null,'race-a-1')->>'result'" >"$r1" &
$P -qAt -c "select commerce_pickup_redeem('$SE','$A','BOOMER_PICKUP:$tok',null,'race-e-1')->>'result'" >"$r2" &
wait
res=$(sort "$r1" "$r2" | tr '\n' ' ')
[ "$res" = "already_redeemed redeemed " ] && echo "PASS concurrent redeem once ($res)" || { echo "FAIL concurrent redeem: $res"; fail=1; }
# 3 退款事务持锁期间核销：提交后必须看到退款中并拒绝
row=$($P -qAt -F' ' -c "select qr_token, fulfillment_id, order_id from commerce_pickup_codes where location_id='$A' and status='active' limit 1")
read tok fid oid <<<"$row"
$P -qAt -c "select commerce_pickup_mark_ready('$SA','$A','$fid','race-ready-2')" >/dev/null
( $P -q -c "begin; select 1 from commerce_orders where id='$oid' for update; update commerce_orders set payment_status='refund_pending' where id='$oid'; select pg_sleep(1.5); commit;" >/dev/null ) &
sleep 0.3
r=$($P -qAt -c "select commerce_pickup_redeem('$SA','$A','BOOMER_PICKUP:$tok',null,'race-refund-1')->>'result'")
wait
[ "$r" = "refund_blocked" ] && echo "PASS refund race blocks redeem" || { echo "FAIL refund race: $r"; fail=1; }
exit $fail
