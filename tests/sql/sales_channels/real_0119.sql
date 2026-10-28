\set ON_ERROR_STOP 1
SET search_path=public,extensions;
-- 0119 回归（真实结构隔离库，虚构数据，结束整体回滚）：共享有赞商品阻断、每件原子、不同商品可部分成功。
DO $$
DECLARE a uuid:='55555555-5555-5555-5555-555555555555'; l uuid:='11111111-1111-1111-1111-111111111111';
  shop uuid:='7a7a7a7a-0000-0000-0000-000000000119';
  s uuid:='22222222-2222-2222-2222-222222222222';   -- 单一映射（标准/孤品均可）
  s3 uuid:='33333333-0000-0000-0000-000000000003';  -- 与 s4 共享同一有赞 item
  s4 uuid:='33333333-0000-0000-0000-000000000004';
  s5 uuid:='33333333-0000-0000-0000-000000000005';  -- 同批另一件，仅关 APP
  r jsonb; n int;
BEGIN
  INSERT INTO auth.users(id) VALUES (a);
  INSERT INTO user_roles(user_id, role) VALUES (a,'store_manager');
  INSERT INTO user_location_perms(user_id, location_id) VALUES (a,l);
  INSERT INTO youzan_shops(id,kdt_id,shop_name,role,status,access_token) VALUES (shop,990119,'测试分店','branch','active','x');
  UPDATE inv_locations SET shop_id=NULL WHERE shop_id=shop AND id<>l;  -- 建店触发器自动建的库位让位给测试库位
  UPDATE inv_locations SET shop_id=shop WHERE id=l;
  INSERT INTO inv_skus(id,category,epc,name,price_tier,sales_state,sale_ownership,status,kind,sku_scope,inventory_policy,is_display)
  SELECT x,'toy','EPC'||right(x::text,4),'测试共享',100,'active','owned','active','single','standard','tracked',true FROM unnest(ARRAY[s3,s4,s5]) x;
  INSERT INTO inv_stocks(sku_id,location_id,qty) SELECT x,l,1 FROM unnest(ARRAY[s3,s4,s5]) x;
  INSERT INTO sku_channel_listings(sku_id,channel,shop_id,external_item_id,listing_status,updated_at) VALUES
    (s,'youzan_branch_offline',shop,'9001','published',now()),
    (s3,'youzan_branch_offline',shop,'9002','published',now()),
    (s4,'youzan_branch_offline',shop,'9002','published',now());

  -- 1) 共享 item：s3 有赞阻断、同件 APP 也不改；s 单一映射正常；s5 同批成功
  r := sales_channel_apply(a,l,gen_random_uuid(),'batch','h1',jsonb_build_array(
    jsonb_build_object('sku_id',s,'channel','youzan','enabled',false,'expected_version',0),
    jsonb_build_object('sku_id',s3,'channel','app','enabled',false,'expected_version',0),
    jsonb_build_object('sku_id',s3,'channel','youzan','enabled',false,'expected_version',0),
    jsonb_build_object('sku_id',s5,'channel','app','enabled',false,'expected_version',0)));
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'results') e WHERE e->>'sku_id'=s3::text AND e->>'channel'='youzan' AND e->>'reason'='youzan_shared_item')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'results') e WHERE e->>'sku_id'=s3::text AND e->>'channel'='app' AND e->>'reason'='sku_not_modified' AND NOT (e->>'success')::boolean)
  THEN RAISE EXCEPTION 'shared item not blocked atomically: %', r; END IF;
  SELECT count(*) INTO n FROM sku_sales_channel_intents WHERE sku_id IN (s3,s4);
  IF n<>0 THEN RAISE EXCEPTION 'shared sku intent written: %', n; END IF;
  SELECT count(*) INTO n FROM channel_sync_outbox WHERE sku_id IN (s3,s4);
  IF n<>0 THEN RAISE EXCEPTION 'shared sku task queued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sku_sales_channel_intents WHERE sku_id=s AND channel='youzan' AND NOT enabled AND version=1)
     OR NOT EXISTS (SELECT 1 FROM channel_sync_outbox WHERE sku_id=s AND action='delist' AND request_payload->>'source'='sales_channel_intent')
  THEN RAISE EXCEPTION 'single-mapping youzan wrongly blocked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sku_sales_channel_intents WHERE sku_id=s5 AND channel='app' AND NOT enabled) THEN
    RAISE EXCEPTION 'other sku in batch not applied'; END IF;
  RAISE NOTICE 'PASS 0119 shared youzan item blocked (whole SKU unmodified, no task); single mapping ok; other SKU applied';

  -- 2) 预览后某渠道被他人改动：同件 APP 不得被改（每件原子）
  UPDATE sku_sales_channel_intents SET version=2 WHERE sku_id=s AND channel='youzan';  -- 模拟预览后被改
  r := sales_channel_apply(a,l,gen_random_uuid(),'batch','h2',jsonb_build_array(
    jsonb_build_object('sku_id',s,'channel','app','enabled',false,'expected_version',0),
    jsonb_build_object('sku_id',s,'channel','youzan','enabled',true,'expected_version',1),
    jsonb_build_object('sku_id',s5,'channel','miniapp','enabled',false,'expected_version',0)));
  IF EXISTS (SELECT 1 FROM sku_sales_channel_intents WHERE sku_id=s AND channel='app') THEN
    RAISE EXCEPTION 'APP changed although youzan conflicted: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'results') e WHERE e->>'sku_id'=s::text AND e->>'channel'='youzan' AND e->>'reason'='version_conflict')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'results') e WHERE e->>'sku_id'=s::text AND e->>'channel'='app' AND e->>'reason'='sku_not_modified')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'results') e WHERE e->>'sku_id'=s5::text AND (e->>'success')::boolean)
  THEN RAISE EXCEPTION 'atomic per-sku result wrong: %', r; END IF;
  SELECT count(*) INTO n FROM channel_sync_outbox WHERE sku_id=s AND action='shelf';
  IF n<>0 THEN RAISE EXCEPTION 'shelf task queued for unmodified sku'; END IF;
  RAISE NOTICE 'PASS 0119 per-SKU atomic: youzan version conflict leaves APP untouched; other SKU still succeeds';
  RAISE EXCEPTION 'ROLLBACK_FIXTURE';
EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'ROLLBACK_FIXTURE' THEN RAISE; END IF;
END $$;

-- 3) 旧 outbox authenticated 读取：意图任务仅本店授权/总部可见，其他任务不变
BEGIN;
INSERT INTO auth.users(id) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a'),('bbbbbbbb-0000-0000-0000-00000000000b');
INSERT INTO inv_locations(id,kind,name,is_active) VALUES ('99999999-9999-9999-9999-999999999999','shop','别店',true);
INSERT INTO user_location_perms(user_id,location_id) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b','99999999-9999-9999-9999-999999999999');
INSERT INTO channel_sync_outbox(sku_id,channel,action,dedupe_key,request_payload) VALUES
  ('22222222-2222-2222-2222-222222222222','youzan_branch_offline','delist','t-intent',
   jsonb_build_object('source','sales_channel_intent','location_id','11111111-1111-1111-1111-111111111111','op_id',gen_random_uuid())),
  ('22222222-2222-2222-2222-222222222222','youzan_branch_offline','set_stock','t-legacy','{}'::jsonb);
GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT ON channel_sync_outbox TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','bbbbbbbb-0000-0000-0000-00000000000b',true);
SELECT CASE WHEN (SELECT count(*) FROM channel_sync_outbox WHERE dedupe_key='t-intent')=0
             AND (SELECT count(*) FROM channel_sync_outbox WHERE dedupe_key='t-legacy')=1
  THEN 'PASS 0119 RLS: other-store staff cannot read intent task; legacy task unchanged' ELSE 'FAIL rls other store' END;
SELECT set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-00000000000a',true);
SELECT CASE WHEN (SELECT count(*) FROM channel_sync_outbox WHERE dedupe_key='t-intent')=1
  THEN 'PASS 0119 RLS: same-store authorized staff can read own intent task' ELSE 'FAIL rls same store' END;
RESET ROLE;
ROLLBACK;
