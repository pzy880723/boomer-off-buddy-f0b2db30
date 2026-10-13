#!/bin/bash
# 隔离库：仅本机临时集群，绝不连生产库
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
P=/tmp/psql.sh
PGDB=postgres $P -c "drop database if exists img_status_test" -c "create database img_status_test" >/dev/null
PGDB=img_status_test $P -q -f tests/sql/listing_image_status/stubs.sql
PGDB=img_status_test $P -q -c "REVOKE ALL ON SCHEMA public FROM public" >/dev/null
PGDB=img_status_test $P -q -f drizzle/migrations/0061_listing_image_terminal_status.sql
PGDB=img_status_test $P -q -c "REVOKE ALL ON FUNCTION public.handheld_listing_image_refresh_status(uuid) FROM public; GRANT EXECUTE ON FUNCTION public.handheld_listing_image_refresh_status(uuid) TO service_role"
PGDB=img_status_test $P -q -f tests/sql/listing_image_status/cases.sql 2>&1 | grep -oE '(PASS|FAIL).*'
