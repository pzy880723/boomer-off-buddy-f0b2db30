#!/bin/bash
set -euo pipefail
bash tests/sql/listing_readiness/run_strict_images.sh
export PGDB=readiness_test
P=/tmp/psql.sh
$P -q -c "CREATE TABLE inv_defect_retouch_receipts(image_path text PRIMARY KEY,source text,actor_user_id uuid,created_at timestamptz DEFAULT now()); CREATE TABLE handheld_item_audit(sku_id uuid,actor_user_id uuid,device_id uuid,action text,changed_fields text[],after_snapshot jsonb); CREATE TABLE handheld_smart_create_ops(sku_id uuid,user_id uuid,device_id uuid,status text);"
$P -q -f drizzle/migrations/0113_validated_retouch_receipt_gate.sql
$P -q -f tests/sql/listing_readiness/cases_retouch_receipts.sql