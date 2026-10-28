#!/bin/bash
# 0119：两个会话并发以同一 token + op_id 执行批量，第二个必须重放同一完整结果，不重复写。
set -euo pipefail
P="$1"   # psql 命令前缀（含连接参数）
A=55555555-5555-5555-5555-555555555555; L=11111111-1111-1111-1111-111111111111
S=22222222-2222-2222-2222-222222222222; OP=$(python3 -c "import uuid;print(uuid.uuid4())"); TOK=$(python3 -c "import uuid;print(uuid.uuid4())")
$P -v ON_ERROR_STOP=1 -c "SET search_path=public,extensions;
 INSERT INTO auth.users(id) VALUES ('$A') ON CONFLICT DO NOTHING;
 INSERT INTO user_roles(user_id,role) VALUES ('$A','store_manager') ON CONFLICT DO NOTHING;
 INSERT INTO user_location_perms(user_id,location_id) VALUES ('$A','$L') ON CONFLICT DO NOTHING;
 DELETE FROM sku_sales_channel_intents WHERE sku_id='$S';
 INSERT INTO sku_sales_channel_previews(token,actor_user_id,location_id,add_channels,remove_channels,items,skipped,sku_ids,expires_at)
 VALUES ('$TOK','$A','$L','{}','{app}',jsonb_build_array(jsonb_build_object('sku_id','$S','changes',jsonb_build_object('app',jsonb_build_object('enabled',false,'expected_version',0)))),'[]',ARRAY['$S'::uuid],now()+interval '5 min');" >/dev/null
Q="SELECT sales_channel_apply_preview('$A','$L','$OP','$TOK')"
( $P -At -c "BEGIN" -c "SET search_path=public,extensions" -c "$Q" -c "SELECT pg_sleep(2)" -c "COMMIT" > /tmp/sc/c1.out 2>&1 ) &
sleep 0.5
$P -At -c "SET search_path=public,extensions" -c "$Q" > /tmp/sc/c2.out 2>&1 || true
wait
R1=$(grep '^{' /tmp/sc/c1.out | head -1); R2=$(grep '^{' /tmp/sc/c2.out | head -1)
N=$($P -At -c "SELECT count(*) FROM public.sku_sales_channel_intents WHERE sku_id='$S'")
python3 - "$R1" "$R2" "$N" <<'PY'
import json,sys
r1=json.loads(sys.argv[1]); r2=json.loads(sys.argv[2]); n=int(sys.argv[3])
ok = r2.get("replayed") is True and r1.get("replayed") is False and r1["results"]==r2["results"] and r1["sku_ids"]==r2["sku_ids"] and n==1
print("PASS 0119 concurrent same token+op: second session replays identical full result, one intent row" if ok else f"FAIL concurrent r1={r1} r2={r2} n={n}")
PY
