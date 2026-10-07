#!/bin/bash
# 渠道同步队列隔离测试：bash tests/sql/channel_sync/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists chsync_test" -c "create database chsync_test" >/dev/null 2>&1
export PGDB=chsync_test
$PSQL -q -f tests/sql/channel_sync/stubs.sql >/dev/null
for m in drizzle/migrations/*_channel_sync_fencing*.sql; do [ -f "$m" ] && $PSQL -q -f "$m" >/dev/null; done
$PSQL -q -f tests/sql/channel_sync/cases.sql 2>&1 | grep -o 'PASS .*\|FAIL.*\|ERROR.*'
