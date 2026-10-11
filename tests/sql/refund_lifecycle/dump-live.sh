#!/bin/bash
# 仅在有只读数据库连接的环境运行（单连接）：导出被测表真实列/PK/UNIQUE/CHECK（无数据、无FK）与现行函数定义快照。
set -euo pipefail
cd "$(dirname "$0")"
cat > /tmp/dump_live.sql <<'SQL'
\pset tuples_only on
\pset format unaligned
\o live_schema.sql
SELECT '-- 自动生成：生产库结构快照（仅列/PK/UNIQUE/CHECK，无数据、无外键）。';
WITH t(n) AS (VALUES ('commerce_orders'),('commerce_payments'),('commerce_refunds'),('commerce_refund_intents'),('commerce_after_sales'),
  ('commerce_payment_events'),('commerce_customer_notifications'),('fulfillments'),('fulfillment_items'),('fulfillment_shortages'),
  ('shipments'),('commerce_pickup_codes'),('commerce_pickup_audit'),('user_roles'),('user_location_perms'),('inv_locations'))
SELECT x FROM (
  SELECT t.n, 1 o, 'CREATE TABLE public.' || t.n || ' (' || string_agg(format('%I %s%s', a.attname,
      CASE WHEN ty.typtype='e' THEN 'text' ELSE format_type(a.atttypid,a.atttypmod) END,
      CASE WHEN d.adbin IS NOT NULL AND pg_get_expr(d.adbin,d.adrelid) NOT LIKE 'nextval%' AND pg_get_expr(d.adbin,d.adrelid) NOT LIKE '%app_role%'
           THEN ' DEFAULT '||pg_get_expr(d.adbin,d.adrelid) ELSE '' END), ', ' ORDER BY a.attnum) || ');' x
  FROM t JOIN pg_attribute a ON a.attrelid=('public.'||t.n)::regclass AND a.attnum>0 AND NOT a.attisdropped
  JOIN pg_type ty ON ty.oid=a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum GROUP BY t.n
  UNION ALL
  SELECT t.n, 2, format('ALTER TABLE public.%I ADD %s;', t.n, pg_get_constraintdef(c.oid))
  FROM t JOIN pg_constraint c ON c.conrelid=('public.'||t.n)::regclass AND c.contype IN ('p','u','c')
  UNION ALL
  SELECT t.n, 3, i.indexdef||';' FROM t JOIN pg_indexes i ON i.schemaname='public' AND i.tablename=t.n AND i.indexdef LIKE 'CREATE UNIQUE%'
    AND i.indexname NOT IN (SELECT conname FROM pg_constraint)
) q ORDER BY n, o;
\o live_functions.sql
SELECT '-- 自动生成：现行函数定义快照，取自数据库当前定义（非迁移文件）。';
SELECT pg_get_functiondef(p.oid)||';' FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN
 ('commerce_apply_ordinary_refund','commerce_settle_refund_intent','commerce_close_order_if_fully_refunded','commerce_pickup_block_reason',
  'commerce_pickup_mark_ready','commerce_pickup_redeem','commerce_pickup_actor_can','fulfillment_complete_pick','commerce_manual_ship_fulfillment')
 ORDER BY p.proname, p.pronargs DESC;
\o
SQL
for i in 1 2 3 4 5; do psql -q -f /tmp/dump_live.sql && exit 0; sleep 8; done; exit 1
