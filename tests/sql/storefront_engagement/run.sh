#!/bin/bash
# 热门发现迁移隔离测试（本地临时集群，不连生产库）：bash tests/sql/storefront_engagement/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=drizzle/migrations/0048_storefront_engagement.sql
PGDB=postgres $PSQL -q -c "drop database if exists engagement_test" -c "create database engagement_test" >/dev/null
export PGDB=engagement_test
$PSQL -q -f tests/sql/storefront_engagement/stubs.sql >/dev/null
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration apply"; exit 1; }
out=$($PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/storefront_engagement/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*'
# 回滚语句可执行
$PSQL -q -v ON_ERROR_STOP=1 -c "DROP FUNCTION public.storefront_record_engagement(uuid,text,uuid,text,text,text); DROP FUNCTION public.storefront_product_engagement_counts(uuid[]); DROP FUNCTION public.storefront_hot_search_terms(int,int); DROP TABLE public.storefront_search_term_hits, public.storefront_product_favorites, public.storefront_product_opens, public.storefront_engagement_quota;" >/dev/null && echo "PASS rollback" || rc=1
[ $rc -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
