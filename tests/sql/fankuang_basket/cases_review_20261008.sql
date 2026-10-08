-- 独立复核 6b7d8feb 的回归用例（隔离库，独立夹具）。每组对应复核问题编号。
\set ON_ERROR_STOP on
INSERT INTO inv_locations(id,name) VALUES
 ('20000000-0000-4000-8000-000000000001','A店'),('20000000-0000-4000-8000-000000000002','B店');
INSERT INTO commerce_customers(id) VALUES
 ('d0000000-0000-4000-8000-000000000001'),('d0000000-0000-4000-8000-000000000002'),('d0000000-0000-4000-8000-000000000003');
-- 150 件可参与商品（2 筐），listing 单价 20
INSERT INTO inv_skus(id, price_tier) SELECT md5('rsku'||g)::uuid, 20 FROM generate_series(1,150) g;
INSERT INTO inv_stocks SELECT md5('rsku'||g)::uuid, CASE WHEN g%2=0 THEN '20000000-0000-4000-8000-000000000001'::uuid ELSE '20000000-0000-4000-8000-000000000002'::uuid END, 1 FROM generate_series(1,150) g;
INSERT INTO commerce_listings(id, sku_id, location_id, price, published_at)
 SELECT md5('rlst'||g)::uuid, md5('rsku'||g)::uuid, s.location_id, 20, now() - (g||' minutes')::interval
 FROM generate_series(1,150) g JOIN inv_stocks s ON s.sku_id=md5('rsku'||g)::uuid;
-- 零元行：特价 0 元的商品（不参与翻筐，只用于下单计数）
INSERT INTO inv_skus(id, is_custom_price, price_tier) VALUES (md5('zero')::uuid, false, 0);
INSERT INTO inv_stocks VALUES (md5('zero')::uuid,'20000000-0000-4000-8000-000000000001',9);
INSERT INTO commerce_listings(id, sku_id, location_id, price) VALUES (md5('zerolst')::uuid, md5('zero')::uuid,'20000000-0000-4000-8000-000000000001', 0);
-- 标准赠礼 SKU：必须 inventory_policy='unlimited'
INSERT INTO inv_skus(id, is_custom_price, price_tier, inventory_policy) VALUES ('99999999-0000-4000-8000-000000000002', false, 0, 'unlimited');
INSERT INTO app_settings(key,value) VALUES ('fankuang_gift_sku_id', '{"sku_id":"99999999-0000-4000-8000-000000000002"}');
SELECT commerce_fankuang_rebuild_round('2026-10-09');

-- 夹具：给顾客 3 个可用资格（直接写翻动+资格，不经抽奖）
DO $$ DECLARE sid uuid; f uuid; i int; BEGIN
  INSERT INTO commerce_fankuang_sessions(customer_id,business_date,basket_no,listing_ids,client_op_id,status)
  VALUES ('d0000000-0000-4000-8000-000000000003','2026-10-01',1,ARRAY[md5('rlst1')::uuid,md5('rlst2')::uuid,md5('rlst3')::uuid],'fixture-sess','completed') RETURNING id INTO sid;
  FOR i IN 1..3 LOOP
    INSERT INTO commerce_fankuang_flips(customer_id,session_id,listing_id,business_date,client_op_id,won)
    VALUES ('d0000000-0000-4000-8000-000000000003',sid,md5('rlst'||i)::uuid,'2026-10-01','fixture-flip-'||i,true) RETURNING id INTO f;
    INSERT INTO commerce_fankuang_gift_entitlements(customer_id,flip_id) VALUES ('d0000000-0000-4000-8000-000000000003',f);
  END LOOP;
END $$;

-- [1] 零元行不计付费件数；total_amount=0 订单不能领赠礼
DO $$ DECLARE base jsonb; ok boolean; r jsonb; BEGIN
  base := jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_recipient_name','李四','p_recipient_phone','13900000000',
    'p_quote_snapshot',NULL,'p_customer_note',NULL,'p_merchant_id','m','p_app_id','a','p_owned_location_ids','[]'::jsonb);
  BEGIN r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
      base || jsonb_build_object('p_idempotency_key','rz1','p_items', jsonb_build_array(
        jsonb_build_object('listing_id',md5('rlst2')::uuid,'quantity',1), jsonb_build_object('listing_id',md5('zerolst')::uuid,'quantity',2))), NULL, 2); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift exceeds paid items%'; END;
  ASSERT ok, '[1] zero-price lines must not count as paid items';
  BEGIN r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
      base || jsonb_build_object('p_idempotency_key','rz2','p_items', jsonb_build_array(jsonb_build_object('listing_id',md5('zerolst')::uuid,'quantity',3))), NULL, 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift requires paid order%'; END;
  ASSERT ok, '[1] zero total order cannot claim gifts';
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE customer_id='d0000000-0000-4000-8000-000000000003' AND status='available') = 3, '[1] nothing consumed';
  RAISE NOTICE 'PASS [1] paid quantity excludes zero-price lines, total_amount>0 guard';
END $$;

-- [2][3] 一天内翻完全部筐：不重复返回已翻商品、明确 basket_empty、补货新品可继续翻
DO $$ DECLARE s jsonb; sid uuid; l uuid; n int := 0; seen uuid[] := '{}'; ok boolean; opn int := 0; BEGIN
  CREATE OR REPLACE FUNCTION commerce_fankuang_draw_wins() RETURNS boolean LANGUAGE sql VOLATILE AS $f$ SELECT false $f$;
  LOOP
    n := n + 1; ASSERT n <= 5, '[2] must not loop forever reopening baskets';
    BEGIN s := commerce_fankuang_start_session('d0000000-0000-4000-8000-000000000001','r-open-'||lpad(n::text,4,'0'),'2026-10-09');
    EXCEPTION WHEN others THEN ASSERT SQLERRM LIKE '%basket empty%', '[2] explicit basket_empty, got '||SQLERRM; EXIT; END;
    sid := (s->>'id')::uuid;
    ASSERT NOT (ARRAY(SELECT jsonb_array_elements_text(s->'listing_ids')::uuid) && seen), '[2] new session must not re-serve today''s flipped listings';
    FOR l IN SELECT jsonb_array_elements_text(s->'listing_ids')::uuid LOOP
      opn := opn + 1;
      PERFORM commerce_fankuang_flip('d0000000-0000-4000-8000-000000000001', sid, l, 'r-flip-'||lpad(opn::text,6,'0'));
      seen := seen || l;
    END LOOP;
    ASSERT (SELECT status FROM commerce_fankuang_sessions WHERE id=sid) = 'completed', '[3] session completes after all seen';
  END LOOP;
  ASSERT cardinality(seen) = 150, '[2] each listing seen exactly once today';
  -- 补货新品后可继续翻，且新快照只含新品
  INSERT INTO inv_skus(id) VALUES (md5('rnew')::uuid);
  INSERT INTO inv_stocks VALUES (md5('rnew')::uuid,'20000000-0000-4000-8000-000000000002',1);
  INSERT INTO commerce_listings(id, sku_id, location_id, price) VALUES (md5('rnewlst')::uuid, md5('rnew')::uuid,'20000000-0000-4000-8000-000000000002', 20);
  s := commerce_fankuang_start_session('d0000000-0000-4000-8000-000000000001','r-open-new1','2026-10-09');
  ASSERT s->'listing_ids' = jsonb_build_array(md5('rnewlst')::uuid), '[2] restocked listing playable, already flipped excluded';
  RAISE NOTICE 'PASS [2] no repeat after all baskets, basket_empty explicit, restock playable';
END $$;

-- [2][3] 跨 session 已翻：只回 already_flipped 也要计入 seen 并能完成；session_json 与 complete 一致
DO $$ DECLARE sid uuid; s jsonb; f jsonb; BEGIN
  INSERT INTO commerce_fankuang_sessions(customer_id,business_date,basket_no,listing_ids,client_op_id)
  VALUES ('d0000000-0000-4000-8000-000000000002','2026-10-09',1,ARRAY[md5('rlst10')::uuid,md5('rlst11')::uuid],'r-legacy-a') RETURNING id INTO sid;
  INSERT INTO commerce_fankuang_flips(customer_id,session_id,listing_id,business_date,client_op_id,won)
  VALUES ('d0000000-0000-4000-8000-000000000002',sid,md5('rlst10')::uuid,'2026-10-09','r-legacy-f1',false);
  UPDATE commerce_fankuang_sessions SET status='completed' WHERE id=sid;
  INSERT INTO commerce_fankuang_sessions(customer_id,business_date,basket_no,listing_ids,client_op_id)
  VALUES ('d0000000-0000-4000-8000-000000000002','2026-10-09',2,ARRAY[md5('rlst10')::uuid,md5('rlst12')::uuid],'r-legacy-b') RETURNING id INTO sid;
  s := commerce_fankuang_session_json(sid);
  ASSERT s->'flipped_listing_ids' @> jsonb_build_array(md5('rlst10')::uuid), '[3] session_json shows same-day flips as seen';
  ASSERT (s->>'remaining_count')::int = 1, '[3] remaining excludes same-day flips';
  f := commerce_fankuang_flip('d0000000-0000-4000-8000-000000000002', sid, md5('rlst10')::uuid, 'r-legacy-f2');
  ASSERT f->>'reason' = 'already_flipped' AND NOT (f->>'session_completed')::boolean, '[2] duplicate does not complete early';
  f := commerce_fankuang_flip('d0000000-0000-4000-8000-000000000002', sid, md5('rlst12')::uuid, 'r-legacy-f3');
  ASSERT (f->>'session_completed')::boolean, '[2] completes when remaining items flipped';
  RAISE NOTICE 'PASS [3] cross-session already_flipped counts as seen, json/complete unified';
END $$;

-- [3] 跨午夜冻结快照：次日新分筐不改变进行中快照；翻动计入快照所属营业日；完成后次日可再翻昨日商品
DO $$ DECLARE s1 jsonb; s2 jsonb; s3 jsonb; sid uuid; l uuid; i int := 0; BEGIN
  DELETE FROM commerce_fankuang_flips WHERE customer_id='d0000000-0000-4000-8000-000000000002';
  DELETE FROM commerce_fankuang_sessions WHERE customer_id='d0000000-0000-4000-8000-000000000002';
  s1 := commerce_fankuang_start_session('d0000000-0000-4000-8000-000000000002','r-mid-open1','2026-10-09');
  sid := (s1->>'id')::uuid;
  PERFORM commerce_fankuang_rebuild_round('2026-10-10');
  s2 := commerce_fankuang_start_session('d0000000-0000-4000-8000-000000000002','r-mid-open2','2026-10-10');
  ASSERT (s2->>'id')::uuid = sid AND s2->'listing_ids' = s1->'listing_ids' AND (s2->>'business_date')::date = '2026-10-09', '[3] frozen across midnight';
  FOR l IN SELECT jsonb_array_elements_text(s1->'listing_ids')::uuid LOOP
    i := i + 1; PERFORM commerce_fankuang_flip('d0000000-0000-4000-8000-000000000002', sid, l, 'r-mid-flip-'||lpad(i::text,5,'0'));
  END LOOP;
  ASSERT NOT EXISTS (SELECT 1 FROM commerce_fankuang_flips WHERE session_id=sid AND business_date <> '2026-10-09'), '[3] flips belong to snapshot business date';
  ASSERT (SELECT status FROM commerce_fankuang_sessions WHERE id=sid) = 'completed', '[3] completes';
  s3 := commerce_fankuang_start_session('d0000000-0000-4000-8000-000000000002','r-mid-open3','2026-10-10');
  ASSERT (s3->>'business_date')::date = '2026-10-10' AND (s3->>'id')::uuid <> sid, '[3] next day new round';
  RAISE NOTICE 'PASS [3] cross-midnight frozen snapshot';
END $$;

-- [4] 动态调用：缺省参数让 DEFAULT 生效；缺必填报错；重载报错
DO $$ DECLARE r jsonb; ok boolean; BEGIN
  ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS customer_note text;
  DROP FUNCTION commerce_create_ordinary_pickup_order(uuid,text,jsonb,text,text,jsonb,text,text,text,uuid[]);
  CREATE FUNCTION commerce_create_ordinary_pickup_order(p_customer_id uuid, p_idempotency_key text, p_items jsonb,
    p_recipient_name text, p_recipient_phone text, p_quote_snapshot jsonb DEFAULT NULL, p_customer_note text DEFAULT 'DEFAULT_NOTE',
    p_merchant_id text DEFAULT NULL, p_app_id text DEFAULT NULL, p_owned_location_ids uuid[] DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql AS $f$ DECLARE r jsonb; BEGIN
    r := commerce_create_ordinary_order(p_customer_id, p_idempotency_key, p_items, p_recipient_name, p_recipient_phone, '{}'::jsonb,
      'platform','STORE_PICKUP',NULL,0,p_quote_snapshot,p_customer_note,p_merchant_id,p_app_id,p_owned_location_ids);
    UPDATE commerce_orders SET customer_note = p_customer_note WHERE id=(r->>'id')::uuid;
    RETURN r; END $f$;
  r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
    jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_idempotency_key','rd1','p_recipient_name','王五',
      'p_recipient_phone','13700000000','p_items', jsonb_build_array(jsonb_build_object('listing_id',md5('rlst20')::uuid,'quantity',1))), NULL, 0);
  ASSERT (SELECT customer_note FROM commerce_orders WHERE idempotency_key='rd1') = 'DEFAULT_NOTE', '[4] omitted arg keeps DEFAULT, not NULL';
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
    jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_idempotency_key','rd2','p_items','[]'::jsonb), NULL, 0); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%missing create argument p_recipient_name%'; END;
  ASSERT ok, '[4] missing required argument rejected';
  CREATE FUNCTION commerce_create_ordinary_pickup_order(p_customer_id uuid, p_idempotency_key text) RETURNS jsonb
    LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
    jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_idempotency_key','rd3'), NULL, 0); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%create function overloaded%'; END;
  ASSERT ok, '[4] overloaded create function rejected';
  DROP FUNCTION commerce_create_ordinary_pickup_order(uuid,text);
  RAISE NOTICE 'PASS [4] dynamic call honours DEFAULT, rejects missing/overload';
END $$;

-- [5] 取消后同键重试固定：不 giftconflict、不二次领取；持久请求快照
DO $$ DECLARE base jsonb; r jsonb; r2 jsonb; ids uuid[]; ok boolean; oid uuid; BEGIN
  SELECT array_agg(id ORDER BY id) INTO ids FROM commerce_fankuang_gift_entitlements WHERE customer_id='d0000000-0000-4000-8000-000000000003' AND status='available';
  base := jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_recipient_name','李四','p_recipient_phone','13900000000',
    'p_items', jsonb_build_array(jsonb_build_object('listing_id',md5('rlst30')::uuid,'quantity',1), jsonb_build_object('listing_id',md5('rlst31')::uuid,'quantity',1)));
  r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order', base || '{"p_idempotency_key":"rc1"}', ids[1:2], 2);
  oid := (r->>'id')::uuid;
  ASSERT (SELECT claimed_ids FROM commerce_order_gift_claims WHERE order_id=oid) = ids[1:2], '[5] claim snapshot persisted';
  UPDATE commerce_orders SET order_status='cancelled' WHERE id=oid;
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE id = ANY(ids[1:2]) AND status='available') = 2, '[5] released once';
  r2 := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order', base || '{"p_idempotency_key":"rc1"}', ids[1:2], 2);
  ASSERT (r2->>'id')::uuid = oid AND (r2->>'gift_replayed')::boolean AND r2->>'gift_claim_status' = 'released', '[5] same-key retry after cancel replays fixed result';
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE id = ANY(ids[1:2]) AND status='available') = 2, '[5] retry does not re-claim';
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order', base || '{"p_idempotency_key":"rc1"}', ids[3:3], 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift idempotency conflict%'; END;
  ASSERT ok, '[5] same key different gifts still conflicts after cancel';
  UPDATE commerce_orders SET order_status='closed' WHERE id=oid;
  ASSERT (SELECT max(release_count) FROM commerce_fankuang_gift_entitlements WHERE id = ANY(ids[1:2])) = 1, '[5] no double release';
  ASSERT (SELECT last_order_id FROM commerce_fankuang_gift_entitlements WHERE id=ids[1]) = oid, '[5] history kept';
  -- 无赠礼的旧订单同键带赠礼重试 → 冲突（基于下单前是否存在，而非 created_at 推测）
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
    jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_idempotency_key','rd1','p_recipient_name','王五','p_recipient_phone','1',
      'p_items', jsonb_build_array(jsonb_build_object('listing_id',md5('rlst20')::uuid,'quantity',1))), NULL, 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift idempotency conflict%'; END;
  ASSERT ok, '[5] pre-existing order without claim conflicts';
  RAISE NOTICE 'PASS [5] persistent claim snapshot, cancel/retry fixed';
END $$;

-- [6] 赠礼 SKU 必须 inventory_policy=unlimited；未配置保持明确
DO $$ DECLARE base jsonb; ok boolean; BEGIN
  base := jsonb_build_object('p_customer_id','d0000000-0000-4000-8000-000000000003','p_recipient_name','李四','p_recipient_phone','13900000000',
    'p_items', jsonb_build_array(jsonb_build_object('listing_id',md5('rlst40')::uuid,'quantity',1)));
  UPDATE inv_skus SET inventory_policy='tracked' WHERE id='99999999-0000-4000-8000-000000000002';
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order', base || '{"p_idempotency_key":"rg1"}', NULL, 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift sku invalid%'; END;
  ASSERT ok, '[6] tracked gift sku rejected';
  UPDATE inv_skus SET inventory_policy='unlimited', status='inactive' WHERE id='99999999-0000-4000-8000-000000000002';
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order', base || '{"p_idempotency_key":"rg2"}', NULL, 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift sku invalid%'; END;
  ASSERT ok, '[6] inactive gift sku rejected';
  DELETE FROM app_settings WHERE key='fankuang_gift_sku_id';
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order', base || '{"p_idempotency_key":"rg3"}', NULL, 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift sku not configured%'; END;
  ASSERT ok, '[6] unconfigured stays explicit';
  RAISE NOTICE 'PASS [6] gift sku must be active unlimited standard sku';
END $$;
