#!/bin/bash
# 并发用例（独立夹具，与 cases.sql 互不干扰）：
# 同一商品两个顾客同时申请 → 只有一个任务、一条门店提醒；
# 两个员工同时保存同一 revision → 恰好一个成功，另一个 revision_conflict。
set -uo pipefail
[ -n "${PSQL:-}" ] || { echo "PSQL not set"; exit 1; }

SKU=00000000-0000-0000-0000-000000000031
L=00000000-0000-0000-0000-000000000041
C1=00000000-0000-0000-0000-000000000021
C2=00000000-0000-0000-0000-000000000022
STAFF=00000000-0000-0000-0000-00000000ff01

$PSQL -q -c "INSERT INTO inv_skus(id,name,location_id) VALUES ('$SKU','并发商品','00000000-0000-0000-0000-00000000000a');
             INSERT INTO commerce_listings(id,sku_id,location_id,status,published_at) VALUES ('$L','$SKU','00000000-0000-0000-0000-00000000000a','published',now())" >/dev/null

# 并发申请
$PSQL -q -c "select public.measurement_request('$L','$C1')" >/dev/null 2>&1 &
$PSQL -q -c "select public.measurement_request('$L','$C2')" >/dev/null 2>&1 &
wait
tasks=$($PSQL -qAt -c "select count(*) from product_measurement_tasks where sku_id='$SKU'")
notifs=$($PSQL -qAt -c "select count(*) from inv_handheld_notifications where kind='measurement_requested' and payload->>'sku_id'='$SKU'")
reqs=$($PSQL -qAt -c "select count(*) from product_measurement_requesters r join product_measurement_tasks t on t.id=r.task_id where t.sku_id='$SKU'")
if [ "$tasks" = "1" ] && [ "$notifs" = "1" ] && [ "$reqs" = "2" ]; then
  echo "PASS concurrent request merges to one task"
else
  echo "FAIL concurrent request: tasks=$tasks notifs=$notifs reqs=$reqs"; exit 1
fi

# 并发保存同一 revision：恰好一个成功
task=$($PSQL -qAt -c "select id from product_measurement_tasks where sku_id='$SKU'")
$PSQL -q -c "select public.measurement_save('$SKU','$task','$STAFF','op-aaaa-0001',0,'00000000-0000-0000-0000-00000000000a',10,null,null,null)" >/tmp/ms_a.out 2>&1 &
$PSQL -q -c "select public.measurement_save('$SKU','$task','$STAFF','op-bbbb-0001',0,'00000000-0000-0000-0000-00000000000a',20,null,null,null)" >/tmp/ms_b.out 2>&1 &
wait
ok=$(grep -l 'replayed.: false' /tmp/ms_a.out /tmp/ms_b.out 2>/dev/null | wc -l)
conf=$(grep -l 'revision_conflict' /tmp/ms_a.out /tmp/ms_b.out 2>/dev/null | wc -l)
rev=$($PSQL -qAt -c "select measurement_revision from inv_skus where id='$SKU'")
done_tasks=$($PSQL -qAt -c "select count(*) from product_measurement_tasks where sku_id='$SKU' and status='completed'")
notified=$($PSQL -qAt -c "select count(*) from commerce_customer_notifications where kind='measurement_completed' and product_id='$L'")
if [ "$ok" = "1" ] && [ "$conf" = "1" ] && [ "$rev" = "1" ] && [ "$done_tasks" = "1" ] && [ "$notified" = "2" ]; then
  echo "PASS concurrent save: exactly one wins"
else
  echo "FAIL concurrent save: ok=$ok conf=$conf rev=$rev done=$done_tasks notified=$notified"
  cat /tmp/ms_a.out /tmp/ms_b.out; exit 1
fi

# 同 op 并发（相同内容）：一个真实执行，一个锁内幂等回放，revision 只 +1
SKU2=00000000-0000-0000-0000-000000000032
L2B=00000000-0000-0000-0000-000000000042
$PSQL -q -c "INSERT INTO inv_skus(id,name,location_id) VALUES ('$SKU2','同op并发商品','00000000-0000-0000-0000-00000000000a');
             INSERT INTO commerce_listings(id,sku_id,location_id,status,published_at) VALUES ('$L2B','$SKU2','00000000-0000-0000-0000-00000000000a','published',now())" >/dev/null
$PSQL -q -c "select public.measurement_save('$SKU2',NULL,'$STAFF','op-same-0001',0,'00000000-0000-0000-0000-00000000000a',10,5,null,null)" >/tmp/ms_c.out 2>&1 &
$PSQL -q -c "select public.measurement_save('$SKU2',NULL,'$STAFF','op-same-0001',0,'00000000-0000-0000-0000-00000000000a',10,5,null,null)" >/tmp/ms_d.out 2>&1 &
wait
rev2=$($PSQL -qAt -c "select measurement_revision from inv_skus where id='$SKU2'")
muts=$($PSQL -qAt -c "select count(*) from measurement_mutations where client_op_id='op-same-0001'")
errs=$(grep -l 'ERROR' /tmp/ms_c.out /tmp/ms_d.out 2>/dev/null | wc -l)
if [ "$rev2" = "1" ] && [ "$muts" = "1" ] && [ "$errs" = "0" ]; then
  echo "PASS concurrent same op: one real one replay"
else
  echo "FAIL concurrent same op: rev=$rev2 muts=$muts errs=$errs"
  cat /tmp/ms_c.out /tmp/ms_d.out; exit 1
fi
