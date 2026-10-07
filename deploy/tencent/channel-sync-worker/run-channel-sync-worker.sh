#!/usr/bin/env bash
# 腾讯侧 channel-sync-worker 触发器（由 systemd timer 调用；Lovable 不部署此文件）。
# 环境文件 /etc/boomer-erp/channel-sync-worker.env（root:root 600）需提供：
#   ERP_BASE_URL=https://erp.boomeroff.com
#   SUPABASE_SERVICE_ROLE_KEY=<服务角色密钥，切勿提交到仓库>
# 可选 canary：CANARY_SKU_ID=<uuid>  CANARY_ACTION=set_stock_zero|delist  LIMIT=1
set -euo pipefail
: "${ERP_BASE_URL:?missing}" "${SUPABASE_SERVICE_ROLE_KEY:?missing}"
body=$(python3 - <<'PY'
import json, os
b = {"limit": int(os.environ.get("LIMIT", "20")), "worker_id": "tencent-" + os.uname().nodename}
if os.environ.get("CANARY_SKU_ID"): b["sku_id"] = os.environ["CANARY_SKU_ID"]
if os.environ.get("CANARY_ACTION"): b["action"] = os.environ["CANARY_ACTION"]
print(json.dumps(b))
PY
)
resp=$(curl -sS --max-time 55 -w '\n%{http_code}' -X POST "$ERP_BASE_URL/api/public/hooks/channel-sync-worker" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'Content-Type: application/json' --data "$body")
code=$(tail -n1 <<<"$resp"); json=$(sed '$d' <<<"$resp")
echo "$(date -Is) http=$code $json"
[ "$code" = "200" ] && grep -q '"ok":true' <<<"$json"
