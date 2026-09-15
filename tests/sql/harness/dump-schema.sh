#!/bin/bash
# 刷新隔离测试用的表结构（**仅结构**：无数据、无权限、无所有者、无凭证）。
# 只在已经配置好数据库连接环境变量的开发环境里运行；输出文件可安全提交。
set -euo pipefail
cd "$(dirname "$0")/../../.."

pg_dump --schema-only --no-owner --no-privileges --schema=public \
  -t public.commerce_customers -t public.commerce_orders -t public.commerce_order_items \
  -t public.commerce_payments -t public.commerce_refund_intents -t public.commerce_refunds \
  -t public.commerce_after_sales -t public.commerce_customer_notifications \
  -t public.commerce_sms_outbox -t public.fulfillments -t public.fulfillment_items \
  -t public.fulfillment_shortages -t public.shipments \
  > tests/sql/harness/schema.sql

echo "wrote tests/sql/harness/schema.sql ($(wc -l < tests/sql/harness/schema.sql) lines, structure only)"
