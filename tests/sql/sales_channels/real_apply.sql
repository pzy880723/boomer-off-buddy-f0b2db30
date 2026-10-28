\set ON_ERROR_STOP 1
SET search_path=public,extensions;
DO $$
DECLARE a uuid:='55555555-5555-5555-5555-555555555555'; l uuid:='11111111-1111-1111-1111-111111111111';
  s uuid:='22222222-2222-2222-2222-222222222222'; s2 uuid:='66666666-6666-6666-6666-666666666666';
  m text; r jsonb; r2 jsonb; tok uuid; op uuid:=gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id) VALUES (a);
  INSERT INTO user_roles(user_id, role) VALUES (a,'store_manager');
  INSERT INTO user_location_perms(user_id, location_id) VALUES (a,l);
  -- 重复 sku+channel
  BEGIN PERFORM sales_channel_apply(a,l,gen_random_uuid(),'batch','h',jsonb_build_array(
      jsonb_build_object('sku_id',s,'channel','app','enabled',false,'expected_version',0),
      jsonb_build_object('sku_id',s,'channel','app','enabled',true,'expected_version',0)));
    m:='no error'; EXCEPTION WHEN OTHERS THEN m:=SQLERRM; END;
  IF m<>'duplicate_change' THEN RAISE EXCEPTION 'duplicate: %',m; END IF;
  -- single 多 SKU
  BEGIN PERFORM sales_channel_apply(a,l,gen_random_uuid(),'single','h',jsonb_build_array(
      jsonb_build_object('sku_id',s,'channel','app','enabled',false,'expected_version',0),
      jsonb_build_object('sku_id',s2,'channel','app','enabled',false,'expected_version',0)));
    m:='no error'; EXCEPTION WHEN OTHERS THEN m:=SQLERRM; END;
  IF m<>'invalid_request' THEN RAISE EXCEPTION 'single multi: %',m; END IF;
  RAISE NOTICE 'PASS real apply: duplicate sku+channel rejected; single with 2 SKUs rejected';
  -- 预览保存原始全部 SKU + skipped；执行与重放返回完整结果
  INSERT INTO sku_sales_channel_previews(actor_user_id,location_id,add_channels,remove_channels,items,skipped,sku_ids,expires_at)
    VALUES (a,l,'{}','{app}',jsonb_build_array(jsonb_build_object('sku_id',s,'changes',jsonb_build_object('app',jsonb_build_object('enabled',false,'expected_version',0)))),
            jsonb_build_array(jsonb_build_object('sku_id',s2,'reason','not_in_store')), ARRAY[s,s2], now()+interval '5 min')
    RETURNING token INTO tok;
  r := sales_channel_apply_preview(a,l,op,tok);
  r2 := sales_channel_apply_preview(a,l,op,tok);
  IF r->'sku_ids' <> jsonb_build_array(s,s2) OR jsonb_array_length(r->'skipped')<>1 OR (r->'results'->0->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'preview result incomplete: %',r; END IF;
  IF (r2->>'replayed')::boolean IS NOT TRUE OR r2->'sku_ids'<>r->'sku_ids' OR r2->'skipped'<>r->'skipped' OR r2->'results'<>r->'results' THEN
    RAISE EXCEPTION 'replay differs: %',r2; END IF;
  RAISE NOTICE 'PASS real preview: original sku_ids + skipped kept; replay returns identical full result';
  RAISE EXCEPTION 'ROLLBACK_FIXTURE';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'ROLLBACK_FIXTURE' THEN RAISE; END IF;
END $$;
