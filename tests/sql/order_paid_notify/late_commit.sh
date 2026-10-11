#!/bin/bash
# 晚提交用例：A 事务先写入一条（ts 人为设为 200 秒前，模拟 >120s 长事务），未提交；
# B 后写入并提交。读者此时不得越过 A 返回 B；A 提交后按游标依次拿到 A、B，无遗漏。
set -uo pipefail
PSQL=${PSQL:-/tmp/psql.sh}
L=00000000-0000-0000-0000-00000000000a
q() { $PSQL -qtA -c "$1"; }
cur=$(q "select coalesce(max(change_xid::xid8)::text,'0')||' '||coalesce(max(change_seq),0) from inv_handheld_notifications")
cx=${cur% *}; cs=${cur#* }
( $PSQL -q -c "begin; insert into inv_handheld_notifications(location_id,kind,title,ts) values ('$L','system','late-A', now()-interval '200 seconds'); select pg_sleep(3); commit;" >/dev/null ) &
sleep 1
q "insert into inv_handheld_notifications(location_id,kind,title) values ('$L','system','early-B')" >/dev/null
during=$(q "select string_agg(title,',') from handheld_notifications_changes(gen_random_uuid(),gen_random_uuid(),array['$L']::uuid[],'$cx',$cs,200)")
wait
after=$(q "select string_agg(title,',' order by change_xid::xid8, change_seq) from handheld_notifications_changes(gen_random_uuid(),gen_random_uuid(),array['$L']::uuid[],'$cx',$cs,200)")
if [ -z "$during" ] && [ "$after" = "late-A,early-B" ]; then echo "PASS late commit (>120s logical) not skipped"; else echo "FAIL late commit during=[$during] after=[$after]"; exit 1; fi
