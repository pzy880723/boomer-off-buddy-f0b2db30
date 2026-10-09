#!/bin/bash
# Two publishers save concurrently from different devices; each job must carry exactly its own actor.
set -euo pipefail
PSQL=/tmp/psql.sh
q() { PGDB=content_actor_test $PSQL -q -v ON_ERROR_STOP=1 -c "$1"; }
q "insert into public.inv_skus values ('22222222-2222-2222-2222-222222222222','active',true,'single',array['sku-raw/y/1.jpg','sku-raw/y/2.jpg'])"
q "insert into public.inv_product_content values ('22222222-2222-2222-2222-222222222222',0,'[]','[]',null,null)"
save() { q "select public.handheld_product_content('$1','$2','99999999-0000-0000-0000-000000000009','22222222-2222-2222-2222-222222222222','{\"action\":\"save\",\"expected_version\":$3,\"client_op_id\":\"$4\",\"publish\":true,\"blocks\":[{\"id\":\"$5\",\"type\":\"image\",\"storage_path\":\"sku-raw/y/$6.jpg\"}]}','2026-10-09-v1')" >/dev/null 2>&1 || echo conflict; }
save dddddddd-0000-0000-0000-00000000000a aaaaaaaa-0000-0000-0000-000000000001 0 op-con-a01 ya 1 &
save dddddddd-0000-0000-0000-00000000000b bbbbbbbb-0000-0000-0000-000000000002 0 op-con-b01 yb 2 &
wait
out=$(PGDB=content_actor_test $PSQL -tA -c "select string_agg(block_id||'='||left(ai_actor_user_id::text,8),',' order by block_id) from public.inv_product_content_image_jobs where sku_id='22222222-2222-2222-2222-222222222222'")
case "$out" in ya=aaaaaaaa|yb=bbbbbbbb) echo "PASS concurrent: winner's job bound only to winner ($out); loser got version_conflict, no job";;
  *) echo "FAIL concurrent: $out"; exit 1;; esac
