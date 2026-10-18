#!/bin/bash
# 新人券包隔离测试（本地临时集群，不连生产库）：bash tests/sql/newcomer_benefit/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${NEWCOMER_MIG-$(ls drizzle/migrations/*_newcomer_benefit_pack.sql 2>/dev/null | head -1)}
mig2=${NEWCOMER_MIG2-$(ls drizzle/migrations/*_newcomer_auto_enroll_and_mirror.sql 2>/dev/null | head -1)}
mig3=${NEWCOMER_MIG3-$(ls drizzle/migrations/*_newcomer_finish_receipt_and_enroll_hardening.sql 2>/dev/null | head -1)}
mig4=${NEWCOMER_MIG4-$(ls drizzle/migrations/*_newcomer_scoped_claim_and_mirror_rotation.sql 2>/dev/null | head -1)}
mig5=${NEWCOMER_MIG5-$(ls drizzle/migrations/*_newcomer_identity_recheck.sql 2>/dev/null | head -1)}
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
CREATE TABLE public.commerce_customer_identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id), provider text NOT NULL, provider_subject text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL);
-- 列定义取自真实库只读结构（pos_customer_coupons 关键约束）
CREATE TABLE public.pos_customer_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE, name text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('amount','percentage')),
  value numeric NOT NULL CHECK (value > 0),
  min_spend numeric NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','used','expired','void')),
  starts_at timestamptz, expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  definition_id uuid, source text NOT NULL DEFAULT 'erp',
  external_provider text, external_id text, idempotency_key text,
  scope text NOT NULL DEFAULT 'platform' CHECK (scope IN ('platform','store')),
  location_id uuid, reserved_order_id uuid);
SQL
$PSQL -q -v ON_ERROR_STOP=1 < "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }
[ -n "$mig2" ] && { $PSQL -q -v ON_ERROR_STOP=1 < "$mig2" >/dev/null || { echo "FAIL migration 0091"; exit 1; }; }
[ -n "$mig3" ] && { $PSQL -q -v ON_ERROR_STOP=1 < "$mig3" >/dev/null || { echo "FAIL migration 0092"; exit 1; }; }
[ -n "$mig4" ] && { $PSQL -q -v ON_ERROR_STOP=1 < "$mig4" >/dev/null || { echo "FAIL migration 0093"; exit 1; }; }
[ -n "$mig5" ] && { $PSQL -q -v ON_ERROR_STOP=1 < "$mig5" >/dev/null || { echo "FAIL migration 0094"; exit 1; }; }
out=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/newcomer_benefit/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
n=$(echo "$out" | grep -c 'PASS')
[ $rc -eq 0 ] && [ "$n" -eq 27 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/27)"; exit 1; }
if [ -n "$mig2" ]; then
  out2=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/newcomer_benefit/cases_0091.sql 2>&1); rc2=$?
  echo "$out2" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
  n2=$(echo "$out2" | grep -c 'PASS')
  [ $rc2 -eq 0 ] && [ "$n2" -eq 20 ] && echo "ALL PASS 0091 ($n2)" || { echo "SOME FAILED 0091 ($n2/20)"; exit 1; }
fi
if [ -n "$mig3" ]; then
  out3=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/newcomer_benefit/cases_0092.sql 2>&1); rc3=$?
  echo "$out3" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
  n3=$(echo "$out3" | grep -c 'PASS')
  [ $rc3 -eq 0 ] && [ "$n3" -eq 18 ] && echo "ALL PASS 0092 ($n3)" || { echo "SOME FAILED 0092 ($n3/18)"; exit 1; }
fi
if [ -n "$mig4" ]; then
  out4=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/newcomer_benefit/cases_0093.sql 2>&1); rc4=$?
  echo "$out4" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
  n4=$(echo "$out4" | grep -c 'PASS')
  [ $rc4 -eq 0 ] && [ "$n4" -eq 14 ] && echo "ALL PASS 0093 ($n4)" || { echo "SOME FAILED 0093 ($n4/14)"; exit 1; }
fi
if [ -n "$mig5" ]; then
  out5=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/newcomer_benefit/cases_0094.sql 2>&1); rc5=$?
  echo "$out5" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
  n5=$(echo "$out5" | grep -c 'PASS')
  [ $rc5 -eq 0 ] && [ "$n5" -eq 11 ] && echo "ALL PASS 0094 ($n5)" || { echo "SOME FAILED 0094 ($n5/11)"; exit 1; }
fi
