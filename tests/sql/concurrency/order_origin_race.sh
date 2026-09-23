#!/bin/bash
# 并发：两个不同来源同时首写，先持锁者胜，后者阻塞后读到已存在来源并原样返回，不覆盖。
set -uo pipefail
PSQL=/tmp/psql.sh
CTX=$($PSQL -At -c "select public.t_mk_order('origin-race', 1, 10.00, 0, 10.00)")
O=$($PSQL -At -c "select ('$CTX'::jsonb)->>'order_id'")
C=$($PSQL -At -c "select ('$CTX'::jsonb)->>'customer_id'")
$PSQL -At >/tmp/orace_a.log 2>&1 <<SQL &
BEGIN; SELECT public.commerce_record_order_origin('$O','$C','miniapp','verified_miniapp_payment'); SELECT pg_sleep(2); COMMIT;
SQL
A=$!; sleep 0.7
$PSQL -At >/tmp/orace_b.log 2>&1 <<SQL &
BEGIN; SELECT public.commerce_record_order_origin('$O','$C','web','client_reported'); COMMIT;
SQL
B=$!; wait $A; wait $B
P=$($PSQL -At -c "select metadata#>>'{sales_origin,platform}' from public.commerce_orders where id='$O'")
N=$($PSQL -At -c "select count(*) from public.commerce_order_origin_audit where order_id='$O'")
if [ "$P" = "miniapp" ] && [ "$N" = "1" ] && grep -q '"miniapp"' /tmp/orace_b.log; then
  echo "PASS concurrency/order_origin_race (来源 $P，审计 $N 条，后到者返回既有来源)"; exit 0; fi
echo "FAIL concurrency/order_origin_race: platform=$P audit=$N"; cat /tmp/orace_b.log; exit 1
