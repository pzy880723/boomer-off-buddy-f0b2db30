#!/bin/bash
set -euo pipefail
bash tests/sql/listing_readiness/run_retouch_receipts.sh
export PGDB=readiness_test
/tmp/psql.sh -q -c "CREATE TABLE IF NOT EXISTS inv_categories(code text,name text,is_active boolean);"
/tmp/psql.sh -q -f drizzle/migrations/0114_legacy_proven_storefront_read_gate.sql
/tmp/psql.sh -q -f tests/sql/listing_readiness/cases_legacy_proven.sql