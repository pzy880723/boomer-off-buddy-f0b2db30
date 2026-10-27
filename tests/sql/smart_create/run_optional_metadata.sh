#!/bin/bash
set -euo pipefail
# Empty local cluster only; current readiness suite supplies real SKU constraints and 0112–0115.
bash tests/sql/listing_readiness/run_current_gallery.sh
export PGDB=readiness_test
/tmp/psql.sh -q -c "DROP TABLE handheld_smart_create_ops CASCADE; CREATE TABLE inv_stock_movements(id uuid DEFAULT gen_random_uuid(),sku_id uuid,location_id uuid,delta integer,balance_after integer,ref_type text,ref_id uuid,epc text,note text,created_by uuid);"
/tmp/psql.sh -q -f drizzle/migrations/0012_handheld_smart_create_idempotency.sql
# Exact reviewed live base commit includes fankuang_override; no production writes.
/tmp/psql.sh -q -f tests/sql/smart_create_cancel/live_handheld_smart_create_commit.def.sql
/tmp/psql.sh -q -f tests/sql/smart_create_cancel/live_handheld_smart_create_commit_v2.def.sql
/tmp/psql.sh -q -c "ALTER TABLE inv_skus ADD COLUMN featured_stamp text; ALTER TABLE inv_skus ADD COLUMN notice_tags text[] NOT NULL DEFAULT '{}';"
/tmp/psql.sh -q -f <(sed '/COMMENT ON COLUMN/,$d' drizzle/migrations/0104_notice_tag_parts_missing.sql)
/tmp/psql.sh -q -f drizzle/migrations/0110_smart_create_cancel_marks.sql
if [ "${1:-}" != "red" ]; then
  /tmp/psql.sh -q -f drizzle/migrations/0116_smart_create_optional_category.sql
fi
/tmp/psql.sh -q -f tests/sql/smart_create/cases_optional_metadata.sql