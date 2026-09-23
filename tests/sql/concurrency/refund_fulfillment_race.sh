#!/bin/bash
# 退款先持有订单锁时，并发拣货/发货必须等待并在退款提交后失败；不得死锁。
set -uo pipefail
PSQL=/tmp/psql.sh

make_refund() {
  local tag="$1" ctx order payment paid tx
  ctx=$($PSQL -At -c "select public.t_mk_order('$tag', 1, 100.00, 0, 100.00)")
  order=$($PSQL -At -c "select ('$ctx'::jsonb)->>'order_id'")
  payment=$($PSQL -At -c "select ('$ctx'::jsonb)->>'payment_id'")
  paid=$($PSQL -At -c "select amount from public.commerce_payments where id='$payment'")
  tx="tx-$tag"
  $PSQL -q -c "update public.commerce_orders set order_status='processing' where id='$order'; update public.commerce_payments set provider_transaction_id='$tx' where id='$payment'; insert into public.commerce_refunds(order_id,payment_id,provider,status,amount,idempotency_key,merchant_refund_no,route_snapshot) values('$order','$payment','wechat','processing',100,'idem-$tag','refund-$tag','{\"merchant_id\":\"m1\"}')" >/dev/null
  printf '%s|%s|%s|%s\n' "$ctx" "$order" "$payment" "$tx"
}

run_refund_holder() {
  local tag="$1" order="$2" payment="$3" tx="$4" log="$5"
  $PSQL -At >"$log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout = '8s';
SELECT public.commerce_apply_ordinary_refund(jsonb_build_object(
  'event_id','event-$tag','status','succeeded','merchant_refund_no','refund-$tag',
  'provider_refund_id','provider-$tag','merchant_id','m1','transaction_id','$tx',
  'total_fen',10000,'refund_fen',10000,'refunded_at',now()));
SELECT pg_sleep(2);
COMMIT;
SQL
  echo $!
}

# 场景 A：退款持锁后，并发增加 picked_qty 必须等待，随后被拒绝。
IFS='|' read -r CTX ORDER PAYMENT TX <<<"$(make_refund 'refund-pick-race')"
FID=$($PSQL -At -c "select ('$CTX'::jsonb)->>'fulfillment_id'")
A=$(run_refund_holder 'refund-pick-race' "$ORDER" "$PAYMENT" "$TX" /tmp/refund_pick_a.log)
sleep 0.5
$PSQL -At >/tmp/refund_pick_b.log 2>&1 <<SQL &
BEGIN; SET LOCAL statement_timeout = '8s';
UPDATE public.fulfillment_items SET picked_qty=1 WHERE fulfillment_id='$FID';
COMMIT;
SQL
B=$!; wait "$A"; AR=$?; wait "$B"; BR=$?
PICKED=$($PSQL -At -c "select picked_qty from public.fulfillment_items where fulfillment_id='$FID'")
STATUS=$($PSQL -At -c "select order_status||'/'||payment_status from public.commerce_orders where id='$ORDER'")
if [ "$AR" -ne 0 ] || [ "$BR" -eq 0 ] || [ "$PICKED" != "0" ] || [ "$STATUS" != "closed/refunded" ] || ! grep -q 'order_refunded' /tmp/refund_pick_b.log; then
  echo "FAIL concurrency/refund_fulfillment_race pick: refund=$AR pick=$BR qty=$PICKED status=$STATUS"; exit 1
fi

# 场景 B：退款持锁后，并发新增 shipment 必须等待，随后被拒绝。
IFS='|' read -r CTX ORDER PAYMENT TX <<<"$(make_refund 'refund-ship-race')"
FID=$($PSQL -At -c "select ('$CTX'::jsonb)->>'fulfillment_id'")
A=$(run_refund_holder 'refund-ship-race' "$ORDER" "$PAYMENT" "$TX" /tmp/refund_ship_a.log)
sleep 0.5
$PSQL -At >/tmp/refund_ship_b.log 2>&1 <<SQL &
BEGIN; SET LOCAL statement_timeout = '8s';
INSERT INTO public.shipments(fulfillment_id,provider,service_code,idempotency_key)
VALUES('$FID','sf','SF_STD','ship-refund-race');
COMMIT;
SQL
B=$!; wait "$A"; AR=$?; wait "$B"; BR=$?
SHIPS=$($PSQL -At -c "select count(*) from public.shipments where fulfillment_id='$FID'")
STATUS=$($PSQL -At -c "select order_status||'/'||payment_status from public.commerce_orders where id='$ORDER'")
if [ "$AR" -ne 0 ] || [ "$BR" -eq 0 ] || [ "$SHIPS" != "0" ] || [ "$STATUS" != "closed/refunded" ] || ! grep -q 'order_refunded' /tmp/refund_ship_b.log; then
  echo "FAIL concurrency/refund_fulfillment_race shipment: refund=$AR ship=$BR rows=$SHIPS status=$STATUS"; exit 1
fi

echo "PASS concurrency/refund_fulfillment_race (退款与拣货/发货按订单串行，无死锁且全退后写入被拒绝)"