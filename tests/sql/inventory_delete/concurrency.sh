#!/bin/bash
# 并发：删除与入库（写 inv_stocks）串行，不得误删有库存 SKU，也不得死锁。
set -uo pipefail
PSQL="/tmp/psql.sh"
export PGDB=inv_delete_test
HQ=$($PSQL -qAt -c "insert into user_roles(user_id,role) values (gen_random_uuid(),'hq_operator') returning user_id")
AUTH="set request.jwt.claim.sub='$HQ'; set request.jwt.claim.role='authenticated'; set role authenticated;"
fail=0

# A) 入库事务先持有引用锁未提交 → 删除等待 → 入库提交后删除必须拒绝
S=$($PSQL -qAt -c "insert into inv_skus default values returning id")
$PSQL -At >/tmp/invdel_a1.log 2>&1 <<SQL &
begin; insert into inv_stocks values ('$S', gen_random_uuid(), 1); select pg_sleep(2); commit;
SQL
P1=$!
sleep 0.5
$PSQL -At >/tmp/invdel_a2.log 2>&1 <<SQL
$AUTH select public.inventory_delete_unused_sku('$S');
SQL
wait $P1
if ! grep -q '仍有库存' /tmp/invdel_a2.log || [ "$($PSQL -At -c "select count(*) from inv_skus where id='$S'")" != 1 ]; then
  echo "FAIL concurrency A"; cat /tmp/invdel_a2.log; fail=1
fi

# B) 删除事务先持锁未提交 → 入库等待 → 删除提交后入库因外键失败，库存不出现孤儿
S=$($PSQL -qAt -c "insert into inv_skus default values returning id")
$PSQL -At >/tmp/invdel_b1.log 2>&1 <<SQL &
$AUTH begin; select public.inventory_delete_unused_sku('$S'); select pg_sleep(2); commit;
SQL
P2=$!
sleep 0.5
$PSQL -At >/tmp/invdel_b2.log 2>&1 <<SQL
insert into inv_stocks values ('$S', gen_random_uuid(), 1);
SQL
wait $P2
if ! grep -q 'foreign key' /tmp/invdel_b2.log || [ "$($PSQL -At -c "select count(*) from inv_stocks where sku_id='$S'")" != 0 ]; then
  echo "FAIL concurrency B"; cat /tmp/invdel_b1.log /tmp/invdel_b2.log; fail=1
fi
grep -qi deadlock /tmp/invdel_*.log && { echo "FAIL deadlock"; fail=1; }
[ $fail = 0 ] && echo "PASS inventory_delete concurrency"
exit $fail
