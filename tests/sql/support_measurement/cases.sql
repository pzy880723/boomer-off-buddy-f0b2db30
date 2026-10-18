\set ON_ERROR_STOP 1
-- A/B 两店；U 员工；C1/C2 顾客；同一 SKU 共享任务
INSERT INTO inv_skus VALUES ('11111111-0000-4000-8000-000000000001','青花碗');
INSERT INTO commerce_customers VALUES ('cc000000-0000-4000-8000-000000000001','甲'),('cc000000-0000-4000-8000-000000000002','乙');
INSERT INTO commerce_listings VALUES ('1a000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-00000000000a','青花碗',99,'11111111-0000-4000-8000-000000000001');
INSERT INTO product_measurement_tasks(id,sku_id,listing_id,location_id) VALUES
 ('7a000000-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000001','1a000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-00000000000a');

CREATE FUNCTION pc(loc text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT handheld_pending_counts('5a000000-0000-4000-8000-000000000001', ARRAY[loc::uuid], false) $$;

DO $$ DECLARE n int; c jsonb; conv uuid; BEGIN
  -- SM1 申请 → 会话 + 一张卡；重复申请不多卡
  INSERT INTO product_measurement_requesters(task_id,customer_id) VALUES ('7a000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001');
  INSERT INTO product_measurement_requesters(task_id,customer_id) VALUES ('7a000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
  PERFORM measurement_attach_support('7a000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000001',now());
  SELECT count(*) INTO n FROM support_messages WHERE card_kind='measurement_request';
  ASSERT n = 1, 'SM1 cards='||n;
  SELECT conversation_id INTO conv FROM product_measurement_requesters WHERE customer_id='cc000000-0000-4000-8000-000000000001';
  ASSERT conv IS NOT NULL AND (SELECT location_id FROM support_conversations WHERE id=conv)='5c000000-0000-4000-8000-00000000000a', 'SM1 conv store';
  RAISE NOTICE 'PASS SM1 request creates one product conversation + one card (idempotent replay)';

  -- SM2 系统卡片不设置/不清除 waiting_since
  ASSERT (SELECT waiting_since FROM support_conversations WHERE id=conv) IS NULL, 'SM2 card set waiting';
  c := pc('5c000000-0000-4000-8000-00000000000a');
  ASSERT c = '{"customers":1,"internal":0,"orders":0,"system":0,"total":1}', 'SM2 '||c;
  ASSERT pc('5c000000-0000-4000-8000-00000000000b')->>'total' = '0', 'SM2 other store sees';
  RAISE NOTICE 'PASS SM2 system card does not touch waiting; counted once; other store isolated';

  -- SM3 同会话顾客追问 + 尺寸：仍只算 1；员工回复清 waiting 但尺寸仍待处理
  UPDATE support_conversations SET primary_agent_id='5a000000-0000-4000-8000-000000000001' WHERE id=conv;
  INSERT INTO support_messages(conversation_id,sender_type,sender_customer_id,body) VALUES (conv,'customer','cc000000-0000-4000-8000-000000000001','x');
  ASSERT pc('5c000000-0000-4000-8000-00000000000a')->>'customers' = '1', 'SM3 dedupe';
  INSERT INTO support_messages(conversation_id,sender_type,sender_user_id,body) VALUES (conv,'staff','5a000000-0000-4000-8000-000000000001','y');
  ASSERT (SELECT waiting_since FROM support_conversations WHERE id=conv) IS NULL, 'SM3 staff clears';
  ASSERT pc('5c000000-0000-4000-8000-00000000000a')->>'customers' = '1', 'SM3 measurement still pending after reply';
  RAISE NOTICE 'PASS SM3 one conversation counted once; staff reply clears waiting, not measurement';

  -- SM4 第二位顾客共享同一任务：另一会话，另计 1；顾客再追问后保存尺寸，仍待回复
  INSERT INTO product_measurement_requesters(task_id,customer_id) VALUES ('7a000000-0000-4000-8000-000000000001','cc000000-0000-4000-8000-000000000002');
  ASSERT pc('5c000000-0000-4000-8000-00000000000a')->>'customers' = '2', 'SM4 two conversations';
  INSERT INTO support_messages(conversation_id,sender_type,sender_customer_id,body) VALUES (conv,'customer','cc000000-0000-4000-8000-000000000001','another question');
  UPDATE product_measurement_tasks SET status='completed' WHERE id='7a000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO n FROM support_messages WHERE card_kind='measurement_completed';
  ASSERT n = 2, 'SM4 completed cards='||n;
  ASSERT (SELECT waiting_since FROM support_conversations WHERE id=conv) IS NOT NULL, 'SM4 save cleared waiting';
  c := pc('5c000000-0000-4000-8000-00000000000a');
  ASSERT c->>'customers' = '1', 'SM4 after save '||c;
  RAISE NOTICE 'PASS SM4 save completes all requesters (2 completed cards), other open question stays pending';

  -- SM5 读过不改变待处理：（计数无已读输入）+ 无会话旧任务单独计 1 + 关闭会话的未完成尺寸仍保留
  INSERT INTO product_measurement_tasks(id,sku_id,listing_id,location_id) VALUES
   ('7a000000-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000001',NULL,'5c000000-0000-4000-8000-00000000000a');
  ASSERT pc('5c000000-0000-4000-8000-00000000000a')->>'customers' = '2', 'SM5 legacy task';
  RAISE NOTICE 'PASS SM5 legacy task without conversation counted separately';
END $$;

-- SM6 回填幂等：重复调用不多卡
DO $$ DECLARE n int; BEGIN
  INSERT INTO product_measurement_tasks(id,sku_id,listing_id,location_id) VALUES
   ('7a000000-0000-4000-8000-000000000003','11111111-0000-4000-8000-000000000001','1a000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-00000000000a');
  ALTER TABLE product_measurement_requesters DISABLE TRIGGER trg_measurement_requester_support;
  INSERT INTO product_measurement_requesters(task_id,customer_id,created_at) VALUES ('7a000000-0000-4000-8000-000000000003','cc000000-0000-4000-8000-000000000002', now()-interval '2 day');
  ALTER TABLE product_measurement_requesters ENABLE TRIGGER trg_measurement_requester_support;
  PERFORM measurement_attach_support('7a000000-0000-4000-8000-000000000003','cc000000-0000-4000-8000-000000000002', now()-interval '2 day');
  PERFORM measurement_attach_support('7a000000-0000-4000-8000-000000000003','cc000000-0000-4000-8000-000000000002', now()-interval '2 day');
  SELECT count(*) INTO n FROM support_messages WHERE measurement_task_id='7a000000-0000-4000-8000-000000000003';
  ASSERT n = 1, 'SM6 '||n;
  ASSERT (SELECT body FROM support_messages WHERE measurement_task_id='7a000000-0000-4000-8000-000000000003') LIKE '【历史申请补录%', 'SM6 marker';
  ASSERT (SELECT count(*) FROM support_messages WHERE measurement_task_id='7a000000-0000-4000-8000-000000000003' AND sender_type<>'system') = 0, 'SM6 fake customer';
  RAISE NOTICE 'PASS SM6 backfill idempotent, marked historical, never a customer message';
END $$;

-- SM7 分页：全量 counts 与分页无关，翻页无重复无遗漏
DO $$ DECLARE r jsonb; seen int := 0; ts timestamptz; id uuid; total int; BEGIN
  INSERT INTO fulfillments(location_id,status,created_at) SELECT '5c000000-0000-4000-8000-00000000000a','allocated', now()-g*interval '1 minute' FROM generate_series(1,120) g;
  INSERT INTO stocktakes(location_id,status) VALUES ('5c000000-0000-4000-8000-00000000000a','scanning');
  INSERT INTO stock_transfers(status,to_location_id) VALUES ('shipped','5c000000-0000-4000-8000-00000000000a'),('received','5c000000-0000-4000-8000-00000000000a');
  r := handheld_work_items('5a000000-0000-4000-8000-000000000001', ARRAY['5c000000-0000-4000-8000-00000000000a']::uuid[], false, 50, NULL, NULL);
  total := (r->'counts'->>'total')::int;
  ASSERT r->'counts'->>'orders' = '120' AND r->'counts'->>'internal' = '2', 'SM7 counts '||(r->'counts')::text;
  ASSERT total = (r->'counts'->>'customers')::int + 122, 'SM7 total sum';
  LOOP
    seen := seen + jsonb_array_length(r->'items');
    EXIT WHEN NOT (r->>'has_more')::boolean;
    r := handheld_work_items('5a000000-0000-4000-8000-000000000001', ARRAY['5c000000-0000-4000-8000-00000000000a']::uuid[], false, 50,
           (r->>'last_ts')::timestamptz, (r->>'last_id')::uuid);
  END LOOP;
  ASSERT seen = total, 'SM7 paged '||seen||' vs '||total;
  RAISE NOTICE 'PASS SM7 full counts independent of page; paging covers all without duplicates';
END $$;

-- SM8 measurement_requested 语音事件归 customers
DO $$ BEGIN
  ASSERT handheld_notification_category('measurement_requested') = 'customers', 'SM8';
  ASSERT handheld_notification_category('transfer_incoming') = 'internal', 'SM8 transfer';
  RAISE NOTICE 'PASS SM8 measurement_requested categorized as customers';
END $$;
