#!/bin/bash
# 新人券包隔离测试（本地临时集群，不连生产库）：bash tests/sql/newcomer_benefit/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${NEWCOMER_MIG-$(ls drizzle/migrations/*_newcomer_benefit_pack.sql 2>/dev/null | head -1)}
mig2=${NEWCOMER_MIG2-$(ls drizzle/migrations/*_newcomer_auto_enroll_and_mirror.sql 2>/dev/null | head -1)}
PGDB=postgres $PSQL -q -c "drop database if exists newcomer_test" -c "create database newcomer_test" >/dev/null
export PGDB=newcomer_test
$PSQL -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || { echo "FAIL stubs"; exit 1; }
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 列定义取自真实库只读结构
CREATE TABLE public.commerce_customers (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, external_subject text NOT NULL, phone text,
  wechat_openid text, wechat_unionid text, nickname text, avatar_url text, status text DEFAULT 'active' NOT NULL,
  last_login_at timestamptz, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL);
SQL
$PSQL -q -v ON_ERROR_STOP=1 < "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }
out=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/newcomer_benefit/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
n=$(echo "$out" | grep -c 'PASS')
[ $rc -eq 0 ] && [ "$n" -eq 27 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/27)"; exit 1; }
