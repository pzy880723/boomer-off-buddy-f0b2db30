#!/bin/bash
# 商品特色印章/提示标签隔离测试（本地临时集群，不连生产库）：bash tests/sql/product_marks/run.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
bash tests/sql/harness/setup.sh >/dev/null
export PSQL=/tmp/psql.sh
mig=${MARKS_MIG-$(ls drizzle/migrations/*_product_featured_stamp_notice_tags.sql 2>/dev/null | head -1)}
PGDB=postgres $PSQL -q -c "drop database if exists marks_test" -c "create database marks_test" >/dev/null
export PGDB=marks_test
$PSQL -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL' || { echo "FAIL stubs"; exit 1; }
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (bucket_id text, name text);
CREATE TABLE public.inv_skus (id uuid PRIMARY KEY, name text, price_tier numeric, notes text, grade text, status text DEFAULT 'active',
  is_custom_price boolean DEFAULT true, fankuang_override boolean, image_paths text[], image_url text, updated_at timestamptz DEFAULT now());
CREATE TABLE public.inv_stocks (sku_id uuid, location_id uuid);
CREATE TABLE public.commerce_listings (sku_id uuid, title text, price numeric, description text, condition_grade text, image_paths jsonb,
  image_urls jsonb, cover_url text, status text, updated_at timestamptz);
CREATE TABLE public.handheld_item_ops (id uuid, device_id uuid, client_op_id text, op_type text, user_id uuid, location_id uuid, sku_id uuid, fingerprint text, response jsonb);
CREATE TABLE public.handheld_youzan_item_sync_outbox (sku_id uuid, shop_id uuid, source_op_id uuid, status text DEFAULT 'pending', next_attempt_at timestamptz, updated_at timestamptz);
CREATE UNIQUE INDEX ON public.handheld_youzan_item_sync_outbox (sku_id, shop_id) WHERE status IN ('pending','failed');
CREATE TABLE public.sku_youzan_links (sku_id uuid, shop_id uuid, role text, status text, sync_stock boolean, yz_item_id bigint);
CREATE TABLE public.sku_channel_listings (sku_id uuid, shop_id uuid, channel text, listing_status text);
CREATE TABLE public.handheld_item_audit (op_id uuid, sku_id uuid, action text, actor_user_id uuid, device_id uuid, location_id uuid, before_snapshot jsonb, after_snapshot jsonb, changed_fields text[]);
CREATE FUNCTION public.handheld_item_replay(uuid,text,text,uuid,uuid,uuid,text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.handheld_item_actor(p_user uuid, p_loc uuid) RETURNS jsonb LANGUAGE sql AS
  $$SELECT jsonb_build_object('hq', p_user = '00000000-0000-0000-0000-0000000000aa', 'manager', false)$$;
CREATE FUNCTION public.handheld_item_fail(code text, msg text) RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '%', code USING DETAIL = msg; END$$;
INSERT INTO public.inv_skus (id, name, price_tier, notes, grade, fankuang_override) VALUES
  ('10000000-0000-0000-0000-000000000001','old',39,'keep','A',NULL);
SQL
$PSQL -q -v ON_ERROR_STOP=1 < "$mig" >/dev/null || { echo "FAIL migration"; exit 1; }
for extra in ${MARKS_EXTRA_MIGS-$(ls drizzle/migrations/*_notice_tag_parts_missing.sql 2>/dev/null)}; do
  $PSQL -q -v ON_ERROR_STOP=1 < "$extra" >/dev/null || { echo "FAIL migration $extra"; exit 1; }
done
out=$($PSQL -q -v ON_ERROR_STOP=1 < tests/sql/product_marks/cases.sql 2>&1); rc=$?
echo "$out" | grep -o 'PASS .*\|ERROR.*\|FAIL.*'
n=$(echo "$out" | grep -c 'PASS')
[ $rc -eq 0 ] && [ "$n" -eq 17 ] && echo "ALL PASS ($n)" || { echo "SOME FAILED ($n/17)"; exit 1; }
