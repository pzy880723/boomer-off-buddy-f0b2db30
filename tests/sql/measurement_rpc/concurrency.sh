#!/bin/bash
# 并发用例：同一商品两个顾客同时申请 → 只有一个任务、一条门店提醒；
# 两个员工同时保存同一 revision → 只有一个成功（revision_conflict）。
set -uo pipefail
[ -n "${PSQL:-}" ] || { echo "PSQL not set"; exit 1; }

L1=00000000-0000-0000-0000-000000000011
SKU1=00000000-0000-0000-0000-000000000001
C1=00000000-0000-0000-0000-000000000021
C2=00000000-0000-0000-0000-000000000022
STAFF=00000000-0000-0000-0000-00000000ff01

# 并发申请
$PSQL -q -c "select public.measurement_request('$L1','$C1')" >/dev/null 2>&1 &
$PSQL -q -c "select public.measurement_request('$L1','$C2')" >/dev/null 2>&1 &
wait
tasks=$($PSQL -qAt -c "select count(*) from product_measurement_tasks where sku_id='$SKU1'")
notifs=$($PSQL -qAt -c "select count(*) from inv_handheld_notifications where kind='measurement_requested'")
reqs=$($PSQL -qAt -c "select count(*) from product_measurement_requesters")
if [ "$tasks" = "1" ] && [ "$notifs" = "1" ] && [ "$reqs" = "2" ]; then
  echo "PASS concurrent request merges to one task"
else
  echo "FAIL concurrent request: tasks=$tasks notifs=$notifs reqs=$reqs"; exit 1
fi

# 并发保存同一 revision：恰好一个成功
task=$($PSQL -qAt -c "select id from product_measurement_tasks where sku_id='$SKU1'")
$PSQL -q -c "select public.measurement_save('$SKU1','$task','$STAFF','op-a',0,10,null,null,null)" >/tmp/ms_a.out 2>&1 &
$PSQL -q -c "select public.measurement_save('$SKU1','$task','$STAFF','op-b',0,20,null,null,null)" >/tmp/ms_b.out 2>&1 &
wait
ok=$(grep -l '"replayed": false\|replayed.:false' /tmp/ms_a.out /tmp/ms_b.out 2>/dev/null | wc -l)
conf=$(grep -l 'revision_conflict' /tmp/ms_a.out /tmp/ms_b.out 2>/dev/null | wc -l)
rev=$($PSQL -qAt -c "select measurement_revision from inv_skus where id='$SKU1'")
done_tasks=$($PSQL -qAt -c "select count(*) from product_measurement_tasks where sku_id='$SKU1' and status='completed'")
if [ "$ok" = "1" ] && [ "$conf" = "1" ] && [ "$rev" = "1" ] && [ "$done_tasks" = "1" ]; then
  echo "PASS concurrent save: exactly one wins"
else
  echo "FAIL concurrent save: ok=$ok conf=$conf rev=$rev done=$done_tasks"
  cat /tmp/ms_a.out /tmp/ms_b.out; exit 1
fi
