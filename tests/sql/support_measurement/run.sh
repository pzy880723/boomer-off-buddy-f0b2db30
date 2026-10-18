#!/bin/bash
# 尺寸申请走客服会话 + 首页待处理聚合 隔离测试（本地临时集群，不连生产库）：bash tests/sql/support_measurement/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
PGDB=postgres $PSQL -q -c "drop database if exists support_measurement_test" -c "create database support_measurement_test" >/dev/null
export PGDB=support_measurement_test
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/support_measurement/stubs.sql >/dev/null || { echo "FAIL stubs"; exit 1; }
mig=${SUPPORT_MEASUREMENT_MIGRATION-$(ls drizzle/migrations/*_support_measurement_cards.sql 2>/dev/null | head -1)}
if [ -n "$mig" ]; then $PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }; else echo "NOTE migration absent (RED run)"; fi
python3 - <<'PYCODE'
from pathlib import Path
import re
out=[]
for file,fn,trg in [('0033_support_assignment_m1.sql','tg_support_waiting','trg_support_waiting'),('0034_support_m1_hardening.sql','tg_support_conversation_touch','trg_support_conversation_touch')]:
 text=Path('drizzle/migrations/'+file).read_text()
 out.append(re.search(r'CREATE OR REPLACE FUNCTION public\.'+fn+r'\(\).*?END; \$\$;',text,re.S).group())
 out.append(re.search(r'CREATE TRIGGER '+trg+r'.*?;',text,re.S).group())
Path('/tmp/measurement-support/production-triggers.sql').write_text('\n'.join(out))
PYCODE
$PSQL -q -f /tmp/measurement-support/production-triggers.sql >/dev/null || exit 1
fix=${SUPPORT_MEASUREMENT_FIX-$(ls drizzle/migrations/*_support_measurement_safe_work_items.sql 2>/dev/null | head -1)}
if [ -n "$fix" ]; then $PSQL -q -f "$fix" >/dev/null || exit 1; fi
out=$($PSQL -q -f tests/sql/support_measurement/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*'
n=$(echo "$out" | grep -c PASS); [ $rc -eq 0 ] && [ "$n" -eq 14 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/14)"; exit 1; }
