#!/bin/bash
# 真实下单函数验证：结构快照来自 pg_dump --schema-only（无数据、无权限、无所有者），载入隔离本地集群。
#   bash tests/sql/sales_channels/run_real.sh            # 需要可只读访问的数据库环境变量来导出结构
set -euo pipefail
cd "$(dirname "$0")/../../.."
W=/tmp/sc; mkdir -p $W; chmod 777 $W
pg_dump --schema-only --no-owner --no-privileges --schema=public > $W/public.sql
cp tests/sql/sales_channels/real_pre.sql tests/sql/sales_channels/real_fixture.sql tests/sql/sales_channels/real_orders.sql tests/sql/sales_channels/real_apply.sql $W/
cp drizzle/migrations/0118_*.sql $W/0118.sql 2>/dev/null || true
cp ${SC_0119:-$(ls drizzle/migrations/0119_*.sql 2>/dev/null | head -1)} $W/0119.sql
cp tests/sql/sales_channels/real_0119.sql $W/
chmod 644 $W/*.sql
bash tests/sql/harness/setup.sh >/dev/null
run() { setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/tmp "$@"; }
run psql -h /tmp -p 55432 -U postgres -d postgres -qc "DROP DATABASE IF EXISTS sc_real" -c "CREATE DATABASE sc_real"
P="psql -h /tmp -p 55432 -U postgres -d sc_real -q"
run $P -f $W/real_pre.sql >/dev/null
run $P -c "SET search_path=public,extensions" -f $W/public.sql > $W/load.log 2>&1 || true
if grep ERROR $W/load.log | grep -v 'schema "public" already exists'; then echo "schema load failed"; exit 1; fi
# 若 0118 尚未在源库应用，则在隔离库补上（已应用时 CREATE OR REPLACE 幂等）
[ -s $W/0118.sql ] && run $P -v ON_ERROR_STOP=1 -f $W/0118.sql >/dev/null
run $P -v ON_ERROR_STOP=1 -f $W/0119.sql >/dev/null
run $P -v ON_ERROR_STOP=1 -f $W/real_fixture.sql >/dev/null
run psql -h /tmp -p 55432 -U postgres -d sc_real -v ON_ERROR_STOP=1 -At -f $W/real_orders.sql 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
run psql -h /tmp -p 55432 -U postgres -d sc_real -v ON_ERROR_STOP=1 -At -f $W/real_apply.sql 2>&1 | sed "s/^psql:[^ ]* NOTICE:  //"
run psql -h /tmp -p 55432 -U postgres -d sc_real -v ON_ERROR_STOP=1 -At -f $W/real_0119.sql 2>&1 | sed "s/^psql:[^ ]* NOTICE:  //" | grep -v "^$\|^BEGIN\|^GRANT\|^SET\|^INSERT\|^ROLLBACK\|^RESET\|^[a-f0-9-]\{36\}$"
run bash tests/sql/sales_channels/real_0119_concurrent.sh "psql -h /tmp -p 55432 -U postgres -d sc_real -q"
