#!/bin/bash
# bash tests/sql/review_demo/run.sh — local isolated cluster only (unix socket), never production.
# Simulates the Tencent demo target: baseline migrations up to 20260731070000, then all rows removed
# (schema-only import), then apply-increment.sh + seed.sql, twice (idempotency).
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
P=/tmp/psql.sh; DB=review_demo_sim; D=deployments/appstore-review-demo-20261009
PGDB=postgres $P -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
export PGDB=$DB
$P -q -f tests/sql/review_demo/supabase-stubs.sql >/dev/null || { echo "FAIL stubs"; exit 1; }
# Baseline-only handling of pre-20260731 history (already present on the demo target):
#   account-creating files are never replayed; identical/near-identical duplicates skipped; cron part cut.
BASE_SKIP="20260518050115_394bc137-409c-4957-9902-799abee9515d.sql 20260518052105_523e93e5-a6ae-44e9-b696-220a368feb93.sql
20260708125231_f9969b9b-571b-42c0-bb56-314a3603207f.sql 20260708125431_65294a64-6f4c-44fb-8eda-99a26e024a2c.sql
20260708130015_7a6b4978-6305-45ef-ba59-88be306ec588.sql 20260708130120_074f31b9-052c-4c3d-ab91-7eda3cda52b0.sql
20260715153000_product_facets_and_brands.sql 20260719110000_harden_aigc_sso_permissions.sql
20260728073853_a0065c38-703a-42b2-a619-f6caaa78fb15.sql 20260713090000_commerce_fulfillment_core.sql"
for f in $(ls supabase/migrations | awk 'substr($0,1,14) <= "20260731070000"'); do
  [[ " $BASE_SKIP " == *"$f"* ]] && continue
  src=supabase/migrations/$f
  if [[ $f == 20260704153607_* ]]; then src=$(mktemp); head -n 56 supabase/migrations/$f > "$src"; fi
  $P -q -1 -f "$src" >/tmp/review_demo_base.log 2>&1 || { echo "FAIL baseline $f"; grep -m2 ERROR /tmp/review_demo_base.log; exit 1; }
done
echo "PASS baseline replay to 20260731070000"
# Schema-only target: remove every row.
$P -q -c "do \$\$ declare t text; begin for t in select format('public.%I',relname) from pg_class where relnamespace='public'::regnamespace and relkind='r' loop execute 'truncate '||t||' cascade'; end loop; end \$\$" -c "truncate auth.users cascade"
HQ=$(cat /proc/sys/kernel/random/uuid); ST=$(cat /proc/sys/kernel/random/uuid)
$P -q -c "insert into auth.users(id,email,raw_user_meta_data) values ('$HQ','demo-hq@review.invalid','{\"name\":\"演示总部账号\"}'),('$ST','demo-staff@review.invalid','{\"name\":\"演示店员\"}')"
URL="postgresql:///$DB?host=/tmp&port=${SHORTAGE_TEST_PGPORT:-55432}&user=postgres"
for round in 1 2; do
  out=$(REVIEW_DATABASE_URL=$URL BOOMER_REVIEW_ISOLATED=true bash $D/apply-increment.sh 2>&1) || { echo "FAIL increment round $round"; echo "$out" | tail -5; exit 1; }
  echo "PASS increment round $round: $(echo "$out" | tail -1)"
  $P -q -v hq_user_id=$HQ -v staff_user_id=$ST -f $D/seed.sql >/tmp/review_demo_seed.log 2>&1 || { echo "FAIL seed round $round"; grep -m3 -E "ERROR|DETAIL" /tmp/review_demo_seed.log; exit 1; }
  echo "PASS seed round $round"
done
# Guards: refuse without flag / with production URL
REVIEW_DATABASE_URL=$URL bash $D/apply-increment.sh >/dev/null 2>&1 && { echo "FAIL ran without flag"; exit 1; } || echo "PASS refuses without BOOMER_REVIEW_ISOLATED"
REVIEW_DATABASE_URL="postgresql://x@db.sxddfcoiaboqcmeviykl.supabase.co/postgres" BOOMER_REVIEW_ISOLATED=true bash $D/apply-increment.sh >/dev/null 2>&1 && { echo "FAIL ran against prod URL"; exit 1; } || echo "PASS refuses production URL"
$P -Atc "select 'tables='||count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
$P -Atc "select 'consent='||(to_regclass('public.handheld_ai_consents') is not null)||' audit='||(to_regclass('public.commerce_membership_admin_audit_logs') is not null)||' fn6='||(select count(*) from pg_proc where proname='handheld_product_content' and pronargs=6)||' fn5='||(select count(*) from pg_proc where proname='handheld_product_content' and pronargs=5)"
$P -Atc "select 'categories='||count(*) from inv_categories" -c "select 'standard_skus='||count(*) from inv_skus where sku_scope='standard' and name not like '演示%'" -c "select 'demo: locations='||(select count(*) from inv_locations where name like '演示%')||' skus='||(select count(*) from inv_skus where name like '演示%')||' orders='||(select count(*) from commerce_orders where metadata->>'demo'='true')||' messages='||(select count(*) from support_messages where body like '【演示】%')||' roles='||(select count(*) from user_roles)"
$P -Atc "select 'non_demo_business_rows='||((select count(*) from commerce_orders where coalesce(metadata->>'demo','')<>'true')+(select count(*) from commerce_customers)+(select count(*) from youzan_shops)+(select count(*) from inv_locations where name not like '演示%'))"
