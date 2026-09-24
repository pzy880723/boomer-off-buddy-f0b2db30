-- 智能上架幂等 / outbox / 重复孤品撤销 隔离测试（库 smart_create_test）
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION pg_temp.sku(tag text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('category','toy','name','玩具屋','price_tier',159,'is_custom_price',true,
    'inventory_policy','tracked','epc','EPC-'||tag,'sku_code','SKU-'||tag,'image_paths', jsonb_build_array('sku-raw/'||tag||'.jpg'),
    'attributes', jsonb_build_object('brand','Sanrio'), 'ip_id', NULL) $$;
DO $$
DECLARE
  dev uuid := gen_random_uuid(); usr uuid := gen_random_uuid(); loc uuid; shop uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; r3 jsonb; n int; ok boolean;
BEGIN
  INSERT INTO inv_locations(kind, shop_id) VALUES ('shop', shop) RETURNING id INTO loc;

  -- 1) 首次提交：建 SKU + 一次入库 + outbox 一条
  r1 := public.handheld_smart_create_commit(dev, usr, 'op-1', 'fp-A', loc, false, pg_temp.sku('1'), '{}', 'n', shop);
  IF (r1->>'replayed')::boolean OR (r1->>'stock_qty')::int <> 1 THEN RAISE EXCEPTION 'FAIL first commit %', r1; END IF;
  -- 2) 超时后重试（同 device/user/op/指纹/location）：原 SKU，库存不再增加
  r2 := public.handheld_smart_create_commit(dev, usr, 'op-1', 'fp-A', loc, false, pg_temp.sku('1b'), '{}', 'n', shop);
  IF NOT (r2->>'replayed')::boolean OR r2->>'sku_id' <> r1->>'sku_id' THEN RAISE EXCEPTION 'FAIL retry %', r2; END IF;
  SELECT count(*) INTO n FROM inv_skus WHERE name='玩具屋';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL retry created sku count=%', n; END IF;
  SELECT qty INTO n FROM inv_stocks WHERE sku_id=(r1->>'sku_id')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL retry stock=%', n; END IF;
  SELECT count(*) INTO n FROM handheld_youzan_release_outbox WHERE sku_id=(r1->>'sku_id')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL outbox count=%', n; END IF;

  -- 3) 载荷冲突 / 用户冲突 / 库位冲突 → P0409
  FOREACH r3 IN ARRAY ARRAY[
    jsonb_build_object('u',usr,'f','fp-B','l',loc),
    jsonb_build_object('u',gen_random_uuid(),'f','fp-A','l',loc),
    jsonb_build_object('u',usr,'f','fp-A','l',gen_random_uuid())] LOOP
    ok := false;
    BEGIN
      PERFORM public.handheld_smart_create_commit(dev, (r3->>'u')::uuid, 'op-1', r3->>'f', (r3->>'l')::uuid, false, pg_temp.sku('x'), '{}', 'n', shop);
    EXCEPTION WHEN SQLSTATE 'P0409' THEN ok := true; END;
    IF NOT ok THEN RAISE EXCEPTION 'FAIL conflict not rejected %', r3; END IF;
  END LOOP;

  -- 4) 完成响应持久化后回放返回同一响应
  PERFORM public.handheld_smart_create_complete((r1->>'op_id')::uuid, '{"ok":true,"data":{"x":1}}');
  r2 := public.handheld_smart_create_commit(dev, usr, 'op-1', 'fp-A', loc, false, pg_temp.sku('1'), '{}', 'n', shop);
  IF r2->'response'->'data'->>'x' <> '1' OR r2->>'op_status' <> 'completed' THEN RAISE EXCEPTION 'FAIL completed replay %', r2; END IF;

  -- 5) 失败回滚：入库失败（location 为空触发异常）时 SKU/op/outbox 全部不落库
  ok := false;
  BEGIN
    PERFORM public.handheld_smart_create_commit(dev, usr, 'op-rb', 'fp', loc, false,
      pg_temp.sku('rb') - 'epc', '{}', 'n', shop);  -- epc NOT NULL 违反
  EXCEPTION WHEN not_null_violation THEN ok := true; END;
  IF NOT ok OR EXISTS (SELECT 1 FROM handheld_smart_create_ops WHERE client_op_id='op-rb') THEN
    RAISE EXCEPTION 'FAIL rollback left op row'; END IF;

  -- 6) 孤品不按名称合并：不同 op 同名同价 → 两条独立 SKU
  r3 := public.handheld_smart_create_commit(dev, usr, 'op-2', 'fp-C', loc, false, pg_temp.sku('2'), '{}', 'n', NULL);
  IF r3->>'sku_id' = r1->>'sku_id' THEN RAISE EXCEPTION 'FAIL custom merged by name'; END IF;
  -- 7) 标准品复用
  r1 := public.handheld_smart_create_commit(dev, usr, 'op-s1', 'fp-s1', loc, true, pg_temp.sku('s') || '{"name":"标准杯","is_custom_price":false}', '{}', 'n', NULL);
  r2 := public.handheld_smart_create_commit(dev, usr, 'op-s2', 'fp-s2', loc, true, pg_temp.sku('s2') || '{"name":"标准杯","is_custom_price":false}', '{}', 'n', NULL);
  IF r1->>'sku_id' <> r2->>'sku_id' OR (r2->>'stock_qty')::int <> 2 THEN RAISE EXCEPTION 'FAIL standard reuse %', r2; END IF;
  -- 8) EPC 绑定计入一次入库
  r1 := public.handheld_smart_create_commit(dev, usr, 'op-e', 'fp-e', loc, false, pg_temp.sku('e'), ARRAY['E1','E2'], 'n', NULL);
  IF (r1->>'stock_qty')::int <> 3 OR (r1->>'bound_epcs')::int <> 2 THEN RAISE EXCEPTION 'FAIL epc %', r1; END IF;
  RAISE NOTICE 'PASS smart_create idempotency (retry/conflict/replay/rollback/no-merge/standard/epc)';
END $$;

-- outbox：租约领取、失败退避、过期租约恢复、陈旧 token 拒绝
DO $$
DECLARE r record; tok uuid; st text; oid uuid;
BEGIN
  SELECT * INTO r FROM public.handheld_release_outbox_claim(5, 60) LIMIT 1;
  IF r.id IS NULL OR r.status <> 'processing' THEN RAISE EXCEPTION 'FAIL claim'; END IF;
  oid := r.id; tok := r.claim_token;
  IF EXISTS (SELECT 1 FROM public.handheld_release_outbox_claim(5, 60) WHERE id = oid) THEN RAISE EXCEPTION 'FAIL double claim'; END IF;
  st := public.handheld_release_outbox_finish(oid, tok, false, 'youzan timeout', NULL);
  IF st <> 'failed' THEN RAISE EXCEPTION 'FAIL backoff %', st; END IF;
  IF public.handheld_release_outbox_finish(oid, tok, true, NULL, NULL) <> 'stale_claim' THEN RAISE EXCEPTION 'FAIL stale token accepted'; END IF;
  -- worker 崩溃：processing 且租约过期 → 可被重新领取
  UPDATE handheld_youzan_release_outbox SET status='processing', lease_until=now()-interval '1 min', next_attempt_at=now() WHERE id=oid;
  SELECT * INTO r FROM public.handheld_release_outbox_claim(5, 60) WHERE id = oid;
  IF r.id IS NULL THEN RAISE EXCEPTION 'FAIL lease recovery'; END IF;
  IF public.handheld_release_outbox_finish(oid, r.claim_token, true, NULL, '{"ok":true}') <> 'done' THEN RAISE EXCEPTION 'FAIL done'; END IF;
  RAISE NOTICE 'PASS release outbox (lease/backoff/recovery/stale token)';
END $$;

-- 重复孤品撤销
DO $$
DECLARE loc uuid; keep uuid; dup uuid; bad uuid; r jsonb; ok boolean; n int;
BEGIN
  INSERT INTO inv_locations(kind) VALUES ('shop') RETURNING id INTO loc;
  INSERT INTO inv_skus(category,price_tier,name,epc,is_custom_price) VALUES ('toy',159,'屋','K',true) RETURNING id INTO keep;
  INSERT INTO inv_skus(category,price_tier,name,epc,is_custom_price) VALUES ('toy',159,'屋','D',true) RETURNING id INTO dup;
  PERFORM inv_apply_movement(keep, loc, 1, 'handheld_smart_create', keep);
  PERFORM inv_apply_movement(dup, loc, 1, 'handheld_smart_create', dup);
  INSERT INTO handheld_youzan_release_outbox(sku_id, shop_id, location_id) VALUES (dup, gen_random_uuid(), loc);
  r := public.inv_revoke_duplicate_sku(dup, keep, loc, 'test');
  IF (SELECT qty FROM inv_stocks WHERE sku_id=dup) <> 0 OR (SELECT qty FROM inv_stocks WHERE sku_id=keep) <> 1 THEN RAISE EXCEPTION 'FAIL revoke stock'; END IF;
  IF (SELECT status||is_display::text FROM inv_skus WHERE id=dup) <> 'archivedfalse' THEN RAISE EXCEPTION 'FAIL revoke archive'; END IF;
  IF (SELECT status FROM inv_skus WHERE id=keep) <> 'active' OR (SELECT status FROM commerce_listings WHERE sku_id=keep) <> 'published' THEN RAISE EXCEPTION 'FAIL kept changed'; END IF;
  IF (SELECT status FROM commerce_listings WHERE sku_id=dup) <> 'archived' THEN RAISE EXCEPTION 'FAIL listing'; END IF;
  IF (SELECT status FROM handheld_youzan_release_outbox WHERE sku_id=dup) <> 'cancelled' THEN RAISE EXCEPTION 'FAIL outbox cancel'; END IF;
  -- 幂等重放：不再追加流水
  r := public.inv_revoke_duplicate_sku(dup, keep, loc, 'test');
  SELECT count(*) INTO n FROM inv_stock_movements WHERE sku_id=dup AND ref_type='manual_adjust' AND note LIKE 'duplicate_listing_revoke%';
  IF NOT (r->>'replayed')::boolean OR n <> 1 THEN RAISE EXCEPTION 'FAIL revoke replay n=%', n; END IF;
  -- 有订单引用 → 拒绝
  INSERT INTO inv_skus(category,price_tier,name,epc) VALUES ('toy',1,'b','B') RETURNING id INTO bad;
  PERFORM inv_apply_movement(bad, loc, 1, 'x', bad);
  INSERT INTO commerce_order_items(sku_id) VALUES (bad);
  ok := false;
  BEGIN PERFORM public.inv_revoke_duplicate_sku(bad, keep, loc, 't'); EXCEPTION WHEN OTHERS THEN ok := SQLERRM LIKE '%订单%'; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL order ref not blocked'; END IF;
  RAISE NOTICE 'PASS duplicate revoke (stock -1/archive/listing/outbox cancel/replay/order block)';
END $$;

-- 权限：authenticated 不能调用
DO $$
BEGIN
  IF has_function_privilege('authenticated','public.handheld_smart_create_commit(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.inv_revoke_duplicate_sku(uuid,uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.handheld_release_outbox_claim(integer,integer)','EXECUTE')
     OR has_table_privilege('authenticated','public.handheld_smart_create_ops','SELECT') THEN
    RAISE EXCEPTION 'FAIL privileges';
  END IF;
  RAISE NOTICE 'PASS privileges service_role only';
END $$;
