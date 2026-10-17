#!/bin/bash
# 夹具与真实库结构一致性检查：隔离库的列（类型/可空/默认值）与 CHECK/PK/UNIQUE 约束
# 必须与 real_schema_*.txt（Lovable Cloud 托管库 information_schema / pg_constraint 只读结果）逐项一致。
set -uo pipefail
here="$(dirname "$0")"
T="'inv_skus','inv_stocks','commerce_listings','inv_locations','inv_listing_image_jobs','inv_product_content','inv_product_content_image_jobs','inv_sku_facets','listing_readiness'"
$PSQL -At -c "select table_name||'|'||column_name||'|'||udt_name||'|'||is_nullable||'|'||coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name in ($T) order by table_name, column_name" > /tmp/fixture_cols.txt
$PSQL -At -c "select conrelid::regclass::text||'|'||contype::text||'|'||pg_get_constraintdef(oid) from pg_constraint where contype in ('c','p','u') and conrelid::regclass::text in ($T) order by conrelid::regclass::text, contype::text, pg_get_constraintdef(oid)" > /tmp/fixture_cons.txt
rc=0
diff <(sort "$here/real_schema_columns.txt") <(sort /tmp/fixture_cols.txt) > /tmp/fixture_cols.diff || { echo "SCHEMA DRIFT columns (< real, > fixture):"; cat /tmp/fixture_cols.diff; rc=1; }
diff <(sort "$here/real_schema_constraints.txt") <(sort /tmp/fixture_cons.txt) > /tmp/fixture_cons.diff || { echo "SCHEMA DRIFT constraints (< real, > fixture):"; cat /tmp/fixture_cons.diff; rc=1; }
[ $rc -eq 0 ] && echo "PASS fixture schema matches real schema"
exit $rc
