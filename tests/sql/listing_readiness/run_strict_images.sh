#!/bin/bash
# Isolated only. Old requirement suite runs before the new strict requirement supersedes it.
set -euo pipefail
bash tests/sql/listing_readiness/run.sh
export PGDB=readiness_test
P=/tmp/psql.sh
$P -q -c "CREATE TABLE IF NOT EXISTS handheld_ai_consents(user_id uuid,policy_version text,allowed boolean);"
m=${1:-$(ls drizzle/migrations/*_durable_image_retry_strict_readiness.sql | head -1)}
$P -q -f "$m"
$P -q -f tests/sql/listing_readiness/cases_strict_images.sql -f tests/sql/listing_image_sla/cases_durable_retry.sql