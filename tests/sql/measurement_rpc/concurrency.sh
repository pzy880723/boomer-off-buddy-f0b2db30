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

# 并发：图片登记 vs 尺寸保存（同一 rev=1）。行锁串行：要么登记 rev1 成功后保存到 rev2（rev2 无素材），
# 要么保存先行使登记 revision_conflict；任何情况下都不能出现 rev2 的 ready 素材。
SKU3=00000000-0000-0000-0000-000000000033
$PSQL -q -c "INSERT INTO inv_skus(id,name,location_id) VALUES ('$SKU3','图片并发商品','00000000-0000-0000-0000-00000000000a')" >/dev/null
$PSQL -q -c "select public.measurement_save('$SKU3',NULL,'$STAFF','op-img-base01',0,'00000000-0000-0000-0000-00000000000a',20,10,null,null)" >/dev/null
P="sku-listing/measurements/$SKU3/1-cccccccccccccccc-640.png"
REG="select public.measurement_asset_register('$SKU3','$STAFF','op-img-conc01','00000000-0000-0000-0000-00000000000a',1,20,10,'cccccccccccccccc','$P','{\"x\":0,\"y\":0,\"w\":10,\"h\":20}',10,20,1)"
$PSQL -q -c "$REG" >/tmp/mi_a.out 2>&1 &
$PSQL -q -c "select public.measurement_save('$SKU3',NULL,'$STAFF','op-img-save02',1,'00000000-0000-0000-0000-00000000000a',25,10,null,null)" >/tmp/mi_b.out 2>&1 &
wait
rev3=$($PSQL -qAt -c "select measurement_revision from inv_skus where id='$SKU3'")
ready1=$($PSQL -qAt -c "select count(*) from product_measurement_assets where sku_id='$SKU3' and revision=1 and status='ready'")
ready2=$($PSQL -qAt -c "select count(*) from product_measurement_assets where sku_id='$SKU3' and revision=2")
regconf=$(grep -c 'revision_conflict' /tmp/mi_a.out)
if [ "$rev3" = "2" ] && [ "$ready2" = "0" ] && { [ "$ready1" = "1" ] && [ "$regconf" = "0" ] || [ "$ready1" = "0" ] && [ "$regconf" = "1" ]; }; then
  echo "PASS concurrent save vs image register serialized"
else
  echo "FAIL concurrent save vs register: rev=$rev3 ready1=$ready1 ready2=$ready2 regconf=$regconf"; cat /tmp/mi_a.out /tmp/mi_b.out; exit 1
fi

# 并发同 op 同图登记：一个真实登记，一个回放，均成功
SKU4=00000000-0000-0000-0000-000000000034
$PSQL -q -c "INSERT INTO inv_skus(id,name,location_id) VALUES ('$SKU4','同op图片并发','00000000-0000-0000-0000-00000000000a')" >/dev/null
$PSQL -q -c "select public.measurement_save('$SKU4',NULL,'$STAFF','op-img-base02',0,'00000000-0000-0000-0000-00000000000a',20,10,null,null)" >/dev/null
P4="sku-listing/measurements/$SKU4/1-dddddddddddddddd-640.png"
REG4="select public.measurement_asset_register('$SKU4','$STAFF','op-img-same01','00000000-0000-0000-0000-00000000000a',1,20,10,'dddddddddddddddd','$P4','{\"x\":0,\"y\":0,\"w\":10,\"h\":20}',10,20,1)"
$PSQL -q -c "$REG4" >/tmp/mi_c.out 2>&1 &
$PSQL -q -c "$REG4" >/tmp/mi_d.out 2>&1 &
wait
errs4=$(grep -l 'ERROR' /tmp/mi_c.out /tmp/mi_d.out 2>/dev/null | wc -l)
replays=$(grep -l 'replayed.: true' /tmp/mi_c.out /tmp/mi_d.out 2>/dev/null | wc -l)
muts4=$($PSQL -qAt -c "select count(*) from measurement_mutations where client_op_id='op-img-same01'")
if [ "$errs4" = "0" ] && [ "$replays" = "1" ] && [ "$muts4" = "1" ]; then
  echo "PASS concurrent same op image register: one real one replay"
else
  echo "FAIL concurrent same op image: errs=$errs4 replays=$replays muts=$muts4"; cat /tmp/mi_c.out /tmp/mi_d.out; exit 1
fi
