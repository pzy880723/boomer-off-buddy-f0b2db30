#!/bin/bash
set -euo pipefail
# Local empty PostgreSQL only; existing suite applies 0112/0113/0114 in isolation.
bash tests/sql/listing_readiness/run_legacy_proven.sh
export PGDB=readiness_test
bun tests/sql/listing_readiness/auto_gallery_fixture.ts
if [ "${1:-}" != "red" ]; then
  /tmp/psql.sh -q -f drizzle/migrations/0115_current_gallery_detail_proof.sql
fi
/tmp/psql.sh -q -f tests/sql/listing_readiness/cases_current_gallery.sql