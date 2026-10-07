#!/bin/bash
# 四位码失败限流并发：30 个不同幂等键并发错码，员工失败计数不得越过 5；QR 不受手输限流影响。
set -euo pipefail
P="${PSQL:-/tmp/psql.sh}"
B=a0000000-0000-4000-8000-000000000002
SB=b0000000-0000-4000-8000-00000000000b
fail=0
for i in $(seq 1 30); do
  $P -qAt -c "select commerce_pickup_redeem('$SB','$B',null,'9999','rl-par-$i-xxxx')->>'result'" >/dev/null &
done
wait
nf=$($P -qAt -c "select count(*) from commerce_pickup_audit where actor_user_id='$SB' and method='code' and result='not_found'")
[ "$nf" -le 5 ] && echo "PASS concurrent wrong codes capped at $nf (<=5)" || { echo "FAIL concurrent wrong codes $nf > 5"; fail=1; }
oid=$($P -qAt -c "with o as (insert into commerce_orders(fulfillment_method) values ('pickup') returning id) select id from o")
$P -qAt -c "select test_mark_paid('$oid', array['$B']::uuid[])" >/dev/null
row=$($P -qAt -F' ' -c "select qr_token, fulfillment_id from commerce_pickup_codes where order_id='$oid'")
tok=${row% *}; fid=${row#* }
$P -qAt -c "select commerce_pickup_mark_ready('$SB','$B','$fid','rl-ready-1')" >/dev/null
r=$($P -qAt -c "select commerce_pickup_redeem('$SB','$B','BOOMER_PICKUP:$tok',null,'rl-qr-1')->>'result'")
[ "$r" = "redeemed" ] && echo "PASS QR not limited by code failures" || { echo "FAIL QR after code limit: $r"; fail=1; }
exit $fail
