#!/bin/bash
# 并发用例：同商品并发申请只一个任务/一条提醒；同 revision 并发保存恰一成功；同 op 并发一真一回放；
# 调拨事务与申请并发不丢申请者。
set -uo pipefail
[ -n "${PSQL:-}" ] || { echo "PSQL not set"; exit 1; }
q() { $PSQL -qAt -c "$1"; }
q "select test_mk(31,'a','a=1'); select test_mk(32,'a','a=1'); select test_mk(33,'a','a=1,b=0')" >/dev/null

q "select measurement_request(l(31),cu(1))" >/dev/null 2>&1 &
q "select measurement_request(l(31),cu(2))" >/dev/null 2>&1 &
wait
t=$(q "select count(*) from product_measurement_tasks where sku_id=s(31)"); n=$(q "select count(*) from inv_handheld_notifications where payload->>'sku_id'=s(31)::text"); r=$(q "select count(*) from product_measurement_requesters r join product_measurement_tasks t on t.id=r.task_id where t.sku_id=s(31)")
[ "$t$n$r" = "112" ] && echo "PASS concurrent request merges to one task" || { echo "FAIL concurrent request $t $n $r"; exit 1; }

q "select measurement_save(s(31),null,st('1'),'op-aaaa-0001',0,loc('a'),10,null,null,null)" >/tmp/ms_a.out 2>&1 &
q "select measurement_save(s(31),null,st('1'),'op-bbbb-0001',0,loc('a'),20,null,null,null)" >/tmp/ms_b.out 2>&1 &
wait
ok=$(grep -l '"replayed": false' /tmp/ms_a.out /tmp/ms_b.out | wc -l); cf=$(grep -l revision_conflict /tmp/ms_a.out /tmp/ms_b.out | wc -l)
nt=$(q "select count(*) from commerce_customer_notifications where kind='measurement_completed' and product_id=l(31)")
[ "$ok$cf$nt" = "112" ] && echo "PASS concurrent save: exactly one wins" || { echo "FAIL concurrent save $ok $cf $nt"; cat /tmp/ms_a.out /tmp/ms_b.out; exit 1; }

q "select measurement_save(s(32),null,st('1'),'op-same-0001',0,loc('a'),10,5,null,null)" >/tmp/ms_c.out 2>&1 &
q "select measurement_save(s(32),null,st('1'),'op-same-0001',0,loc('a'),10,5,null,null)" >/tmp/ms_d.out 2>&1 &
wait
rv=$(q "select measurement_revision from inv_skus where id=s(32)"); er=$(grep -l ERROR /tmp/ms_c.out /tmp/ms_d.out | wc -l)
[ "$rv$er" = "10" ] && echo "PASS concurrent same op: one real one replay" || { echo "FAIL same op $rv $er"; exit 1; }

# 调拨事务（A→0 再 B→1，中间 sleep）与申请并发：最终任务在 B，申请者不丢
q "select measurement_request(l(33),cu(1))" >/dev/null
$PSQL -qAt -c "begin; update inv_stocks set qty=0 where sku_id=s(33) and location_id=loc('a'); select pg_sleep(0.5); update inv_stocks set qty=1 where sku_id=s(33) and location_id=loc('b'); commit;" >/dev/null 2>&1 &
sleep 0.2
q "select measurement_request(l(33),cu(2))" >/tmp/ms_e.out 2>&1
wait
loc=$(q "select location_id=loc('b') from product_measurement_tasks where sku_id=s(33) and status in ('pending','claimed')"); rq=$(q "select count(*) from product_measurement_requesters r join product_measurement_tasks t on t.id=r.task_id where t.sku_id=s(33)"); nn=$(q "select count(*) from inv_handheld_notifications where payload->>'sku_id'=s(33)::text and action_status is null and location_id=loc('b')")
[ "$loc" = "t" ] && [ "$rq" = "2" ] && [ "$nn" = "1" ] && echo "PASS transfer concurrent with request keeps requesters" || { echo "FAIL transfer concurrency loc=$loc rq=$rq nn=$nn"; cat /tmp/ms_e.out; exit 1; }

# 领取与调拨竞态：A 员工领取请求被调拨事务（持有 task 锁）阻塞，提交后锁内重查 → A forbidden；B 可领
q "select test_mk(34,'a','a=1,b=0')" >/dev/null
t34=$(q "select measurement_request(l(34),cu(1))->>'task_id'")
$PSQL -qAt -c "begin; update inv_stocks set qty=0 where sku_id=s(34) and location_id=loc('a'); update inv_stocks set qty=1 where sku_id=s(34) and location_id=loc('b'); select measurement_task_rebalance(s(34)); select pg_sleep(0.6); commit;" >/dev/null 2>&1 &
sleep 0.2
q "select measurement_claim('$t34', st('1'))" >/tmp/mc_a.out 2>&1
wait
b=$(q "select measurement_claim('$t34', st('2'))->>'status'" 2>&1)
by=$(q "select claimed_by=st('2') from product_measurement_tasks where id='$t34'")
grep -q forbidden /tmp/mc_a.out && [ "$b" = "claimed" ] && [ "$by" = "t" ] && echo "PASS concurrent claim vs transfer: old store loses" || { echo "FAIL claim race b=$b by=$by"; cat /tmp/mc_a.out; exit 1; }

# 首申请未提交窗口：T1 首次 request 未提交（已读库存 A=1），T2 调拨 A0B1 提交；
# T2 的 deferred trigger 等 T1 的 SKU advisory 锁，T1 提交后看见任务并转派 → 最终任务/单提醒在 B，申请者保留，无死锁
q "select test_mk(35,'a','a=1,b=0')" >/dev/null
$PSQL -qAt -c "begin; select measurement_request(l(35),cu(1)); select pg_sleep(1.0); commit;" >/tmp/mf_t1.out 2>&1 &
p1=$!
sleep 0.3
$PSQL -qAt -c "begin; update inv_stocks set qty=0 where sku_id=s(35) and location_id=loc('a'); update inv_stocks set qty=1 where sku_id=s(35) and location_id=loc('b'); commit;" >/tmp/mf_t2.out 2>&1 &
p2=$!
wait $p1; r1=$?; wait $p2; r2=$?
loc=$(q "select location_id=loc('b') from product_measurement_tasks where sku_id=s(35) and status in ('pending','claimed')")
nn=$(q "select count(*) from inv_handheld_notifications where payload->>'sku_id'=s(35)::text")
nb=$(q "select count(*) from inv_handheld_notifications where payload->>'sku_id'=s(35)::text and location_id=loc('b') and action_status is null")
rq=$(q "select count(*) from product_measurement_requesters r join product_measurement_tasks t on t.id=r.task_id where t.sku_id=s(35)")
if [ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ "$loc" = "t" ] && [ "$nn$nb$rq" = "111" ] && ! grep -qi deadlock /tmp/mf_t1.out /tmp/mf_t2.out; then
  echo "PASS uncommitted first request vs committed transfer: task at B, one notice, requester kept"
else
  echo "FAIL first-request window loc=$loc nn=$nn nb=$nb rq=$rq r1=$r1 r2=$r2"; cat /tmp/mf_t1.out /tmp/mf_t2.out; exit 1
fi
