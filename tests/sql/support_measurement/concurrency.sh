#!/bin/bash
set -euo pipefail
export PGDB=support_measurement_test
p=/tmp/psql.sh
# Uses synthetic task/customer left by run.sh, no production connection.
for i in 1 2 3 4; do
 "$p" -q -c "SELECT measurement_attach_support('7a000000-0000-4000-8000-000000000009','cc000000-0000-4000-8000-000000000001');" > /tmp/measurement-support/concurrent-$i.log &
done
wait
"$p" -q -c "DO \$\$ BEGIN ASSERT (SELECT count(*) FROM support_messages WHERE measurement_task_id='7a000000-0000-4000-8000-000000000009' AND card_kind='measurement_request')=1,'concurrent duplicate card'; ASSERT (SELECT count(*) FROM product_measurement_requesters WHERE task_id='7a000000-0000-4000-8000-000000000009' AND customer_id='cc000000-0000-4000-8000-000000000001')=1,'concurrent duplicate requester'; RAISE NOTICE 'PASS concurrent attachment: 4 calls, one card'; END \$\$;"
