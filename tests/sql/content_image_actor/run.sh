#!/bin/bash
# bash tests/sql/content_image_actor/run.sh — isolated local cluster, never production.
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
PSQL=/tmp/psql.sh
mig=$(ls drizzle/migrations/*_content_image_job_actor.sql 2>/dev/null | head -1)
[ -n "$mig" ] || mig=/tmp/mig0047.sql
PGDB=postgres $PSQL -q -c "drop database if exists content_actor_test" -c "create database content_actor_test" >/dev/null
export PGDB=content_actor_test
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/content_image_actor/stubs.sql >/dev/null || { echo "FAIL stubs"; exit 1; }
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migration apply"; exit 1; }
$PSQL -q -v ON_ERROR_STOP=1 -f tests/sql/content_image_actor/cases.sql 2>&1 | grep -o 'PASS.*\|FAIL.*\|ERROR.*'
bash tests/sql/content_image_actor/concurrent.sh
# Rollback statements from 0046 + this migration must parse and run (on a throwaway DB).
PGDB=postgres $PSQL -q -c "drop database if exists rollback_test" -c "create database rollback_test" >/dev/null
export PGDB=rollback_test
$PSQL -q -f tests/sql/content_image_actor/stubs.sql >/dev/null
$PSQL -q -c "create schema if not exists auth" -c "create function auth.uid() returns uuid language sql as 'select null::uuid'" -c "create table public.custom_print_cards(id uuid)" -c "create table public.inv_listing_image_jobs(id uuid)" >/dev/null
$PSQL -q -v ON_ERROR_STOP=1 -f drizzle/migrations/0046_handheld_ai_consent.sql >/dev/null || { echo "FAIL 0046 apply"; exit 1; }
$PSQL -q -v ON_ERROR_STOP=1 -f "$mig" >/dev/null
for f in drizzle/migrations/0046_handheld_ai_consent.sql "$mig"; do
  sed -n 's/^--   //p' "$f" | $PSQL -q -v ON_ERROR_STOP=1 >/dev/null && echo "PASS rollback runs: $(basename $f)" || { echo "FAIL rollback $(basename $f)"; exit 1; }
done
