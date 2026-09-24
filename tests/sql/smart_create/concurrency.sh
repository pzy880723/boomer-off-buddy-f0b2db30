#!/bin/bash
# 并发：同 (device,user,op) 两个请求同时提交 → 只建 1 条 SKU、库存 1、outbox 1，后到者拿到原 SKU。
set -uo pipefail
PSQL="/tmp/psql.sh"
export PGDB=smart_create_test
DEV=$($PSQL -qAt -c "select gen_random_uuid()")
USR=$($PSQL -qAt -c "select gen_random_uuid()")
SHOP=$($PSQL -qAt -c "select gen_random_uuid()")
LOC=$($PSQL -qAt -c "insert into inv_locations(kind,shop_id) values ('shop','$SHOP') returning id")
SKU="jsonb_build_object('category','toy','name','并发屋','price_tier',159,'is_custom_price',true,'epc','EPC-C'||md5(random()::text),'sku_code','S')"
CALL="select public.handheld_smart_create_commit('$DEV','$USR','op-race','fp','$LOC',false,$SKU,'{}','n','$SHOP')"
fail=0
$PSQL -At >/tmp/sc_c1.log 2>&1 <<SQL &
begin; $CALL; select pg_sleep(2); commit;
SQL
P1=$!
sleep 0.5
$PSQL -At >/tmp/sc_c2.log 2>&1 <<SQL
$CALL;
SQL
wait $P1
S1=$(grep -o '"sku_id": "[^"]*"' /tmp/sc_c1.log); S2=$(grep -o '"sku_id": "[^"]*"' /tmp/sc_c2.log)
if [ -z "$S1" ] || [ "$S1" != "$S2" ] || ! grep -q '"replayed": true' /tmp/sc_c2.log; then echo "FAIL race sku"; cat /tmp/sc_c1.log /tmp/sc_c2.log; fail=1; fi
[ "$($PSQL -At -c "select count(*) from inv_skus where name='并发屋'")" = 1 ] || { echo "FAIL race sku count"; fail=1; }
[ "$($PSQL -At -c "select sum(qty) from inv_stocks s join inv_skus k on k.id=s.sku_id where k.name='并发屋'")" = 1 ] || { echo "FAIL race stock"; fail=1; }
[ "$($PSQL -At -c "select count(*) from handheld_youzan_release_outbox o join inv_skus k on k.id=o.sku_id where k.name='并发屋'")" = 1 ] || { echo "FAIL race outbox"; fail=1; }

# 先到者回滚（例如请求中途崩溃）→ 后到者正常建品，不丢单
$PSQL -At >/tmp/sc_r1.log 2>&1 <<SQL &
begin; select public.handheld_smart_create_commit('$DEV','$USR','op-rb2','fp','$LOC',false,$SKU||'{"name":"回滚屋"}','{}','n',NULL); select pg_sleep(2); rollback;
SQL
P2=$!
sleep 0.5
$PSQL -At >/tmp/sc_r2.log 2>&1 <<SQL
select public.handheld_smart_create_commit('$DEV','$USR','op-rb2','fp','$LOC',false,$SKU||'{"name":"回滚屋"}','{}','n',NULL);
SQL
wait $P2
grep -q '"replayed": false' /tmp/sc_r2.log && [ "$($PSQL -At -c "select count(*) from inv_skus where name='回滚屋'")" = 1 ] || { echo "FAIL rollback race"; cat /tmp/sc_r2.log; fail=1; }
grep -qi deadlock /tmp/sc_*.log && { echo "FAIL deadlock"; fail=1; }
[ $fail = 0 ] && echo "PASS smart_create concurrency (same op race / first rollback)"
exit $fail
