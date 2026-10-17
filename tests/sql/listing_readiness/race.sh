#!/bin/bash
# 真实并发：同一 SKU 两个门店 listing 已在待发布(hold)状态，A/B 各自更新本店 listing（持行锁未提交），
# 期间详情完成并提交；两边随后提交，提交复核不得形成 listing↔listing / listing↔readiness 锁环。
# 依赖 run.sh 刚建好的 readiness_test 库。用法：bash tests/sql/listing_readiness/race.sh
set -uo pipefail
export PSQL=/tmp/psql.sh PGDB=readiness_test
S=c0000000-0000-0000-0000-0000000000$(printf '%02d' $((RANDOM % 90 + 10)))
B=00000000-0000-0000-0000-00000000000b
$PSQL -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO inv_locations (id, kind, name) VALUES ('$B','shop','B店') ON CONFLICT DO NOTHING;
SELECT mk2('$S', true, ARRAY['sku-listing/r/1.png']);
INSERT INTO inv_stocks (sku_id, location_id, qty) VALUES ('$S','00000000-0000-0000-0000-00000000000a',1),('$S','$B',1);
INSERT INTO commerce_listings (sku_id, location_id, title, price, status) VALUES
  ('$S','00000000-0000-0000-0000-00000000000a','r',1,'published'),('$S','$B','r',1,'published');
UPDATE listing_readiness SET images_settled=true WHERE sku_id='$S'; SELECT listing_readiness_refresh('$S');
SQL
rm -f /tmp/rr_*.log
$PSQL -At >/tmp/rr_a.log 2>&1 <<SQL &
BEGIN; UPDATE commerce_listings SET title='A改' WHERE sku_id='$S' AND location_id='00000000-0000-0000-0000-00000000000a';
SELECT pg_sleep(2); COMMIT;
SQL
A=$!
$PSQL -At >/tmp/rr_b.log 2>&1 <<SQL &
BEGIN; UPDATE commerce_listings SET title='B改' WHERE sku_id='$S' AND location_id='$B';
SELECT pg_sleep(2.3); COMMIT;
SQL
Bp=$!; sleep 0.6
t0=$(date +%s.%N)
$PSQL -At >/tmp/rr_c.log 2>&1 -c "select pub2('$S','并发')"
tc=$(echo "$(date +%s.%N) - $t0" | bc)
wait $A; wait $Bp
N=$($PSQL -At -c "select count(*) from commerce_listings where sku_id='$S' and status='published' and not readiness_hold")
if grep -qi deadlock /tmp/rr_*.log; then echo "FAIL race: deadlock detected"; grep -hi deadlock /tmp/rr_*.log; exit 1; fi
if [ "$N" = "2" ] && (( $(echo "$tc < 1.2" | bc) )); then
  echo "PASS race: no lock cycle, content commit not blocked (${tc}s), both held listings published at their own commit"; exit 0; fi
echo "FAIL race: published=$N content_wait=${tc}s"; cat /tmp/rr_*.log; exit 1
