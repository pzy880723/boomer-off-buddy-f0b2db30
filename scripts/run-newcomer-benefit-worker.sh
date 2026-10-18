#!/bin/bash
# 新人券包发放 worker（腾讯固定出口主机运行）：调用本项目的 service-role Bearer 受保护钩子。
# 开关默认关闭（服务端 NEWCOMER_BENEFIT_WORKER_ENABLED），关闭时钩子不领取任何槽位。
# 安装：/etc/boomer-erp/workers.env 提供 SUPABASE_SERVICE_ROLE_KEY 与 ERP_BASE_URL。
set -euo pipefail
BASE="${ERP_BASE_URL:-https://erp.boomeroff.com}"
: "${SUPABASE_SERVICE_ROLE_KEY:?missing service role key}"
curl -fsS -m 30 -X POST "$BASE/api/public/hooks/newcomer-benefit-worker" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data '{}'
echo
