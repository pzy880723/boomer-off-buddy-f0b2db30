-- 手持待办/通知整改回归：测量忽略、同步失败投影、微秒分页。每步 DO+ASSERT，失败即 ERROR。
-- 运行：bash tests/sql/handheld_work_items/run.sh（本地临时集群，绝不连生产库）。
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid();
  loc uuid := gen_random_uuid(); loc_b uuid := gen_random_uuid();
  shop uuid := gen_random_uuid(); shop0 uuid := gen_random_uuid(); shop2 uuid := gen_random_uuid();
  sku uuid := gen_random_uuid(); task uuid := gen_random_uuid();
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  v_ver timestamptz; v_res jsonb; v_page1 jsonb; v_page2 jsonb;
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  v_cnt int; v_ts text; v_id text;
BEGIN
  INSERT INTO inv_locations(id, shop_id, is_active) VALUES
    (loc, shop, true), (loc_b, gen_random_uuid(), true),
    (gen_random_uuid(), shop2, true), (gen_random_uuid(), shop2, true);
  INSERT INTO inv_skus(id, name) VALUES (sku, '回归商品');
  INSERT INTO product_measurement_tasks(id, sku_id, location_id, status, created_at)
    VALUES (task, sku, loc, 'pending', '2026-10-22 09:00:00+00');
  INSERT INTO product_measurement_requesters(task_id, customer_id, created_at)
    VALUES (task, gen_random_uuid(), '2026-10-22 09:00:00.123456+00');
  v_ver := measurement_task_request_version(task);

  -- 1 忽略后本人待办不再有该测量行
  PERFORM measurement_task_dismiss(task, u_a, loc, v_ver);
  SELECT handheld_work_items(u_a, ARRAY[loc], false, 50) INTO v_res;
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i WHERE i->>'measurement_task_id' = task::text), 'dismissed row still visible';
  RAISE NOTICE 'PASS 1 dismiss hides row';

  -- 2 其他员工不受影响
  SELECT handheld_work_items(u_b, ARRAY[loc], false, 50) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i WHERE i->>'measurement_task_id' = task::text), 'other user lost row';
  RAISE NOTICE 'PASS 2 other user unaffected';

  -- 3 撤销忽略后恢复
  PERFORM measurement_task_undismiss(task, u_a, loc, v_ver);
  SELECT handheld_work_items(u_a, ARRAY[loc], false, 50) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i WHERE i->>'measurement_task_id' = task::text), 'undismiss did not restore';
  RAISE NOTICE 'PASS 3 undismiss restores';

  -- 4 ignored_only 只列已忽略且 can_restore=true
  PERFORM measurement_task_dismiss(task, u_a, loc, v_ver);
  SELECT handheld_work_items(u_a, ARRAY[loc], false, 50, NULL, NULL, false, true) INTO v_res;
  ASSERT jsonb_array_length(v_res->'items') = 1, 'ignored_only count wrong';
  ASSERT (v_res->'items'->0->>'can_restore')::boolean, 'ignored_only row not restorable';
  RAISE NOTICE 'PASS 4 ignored_only restorable';

  -- 5 include_ignored 同时带 ignored 标记
  SELECT handheld_work_items(u_a, ARRAY[loc], false, 50, NULL, NULL, true, false) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'measurement_task_id' = task::text AND (i->>'ignored')::boolean), 'include_ignored missing flag';
  RAISE NOTICE 'PASS 5 include_ignored flagged';

  -- 6 同 task 新 requester 版本 → 重新出现（旧忽略不吞新请求）
  INSERT INTO product_measurement_requesters(task_id, customer_id, created_at)
    VALUES (task, gen_random_uuid(), '2026-10-22 10:00:00.654321+00');
  SELECT handheld_work_items(u_a, ARRAY[loc], false, 50) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i WHERE i->>'measurement_task_id' = task::text), 'new requester version swallowed';
  RAISE NOTICE 'PASS 6 new version reappears';

  -- 7 跨店忽略被拒绝
  BEGIN
    PERFORM measurement_task_dismiss(task, u_b, loc_b, measurement_task_request_version(task));
    ASSERT false, 'cross-store dismiss not rejected';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM = 'task_location_mismatch', 'unexpected error: ' || SQLERRM;
  END;
  RAISE NOTICE 'PASS 7 cross-store rejected';

  -- 8 计数与分页一致：逐页 UNION 去重后等于全量
  INSERT INTO product_measurement_tasks(id, sku_id, location_id, status, created_at)
    VALUES (t1, sku, loc, 'pending', '2026-10-22 11:00:00.000001+00'),
           (t2, sku, loc, 'pending', '2026-10-22 11:00:00.000002+00');
  SELECT handheld_work_items(u_b, ARRAY[loc], false, 2) INTO v_page1;
  SELECT handheld_work_items(u_b, ARRAY[loc], false, 50) INTO v_res;
  v_ts := v_page1->>'last_ts'; v_id := v_page1->>'last_id';
  ASSERT v_ts IS NOT NULL AND (v_page1->>'has_more')::boolean, 'page1 should have more';
  SELECT handheld_work_items(u_b, ARRAY[loc], false, 50, v_ts::timestamptz, v_id::uuid) INTO v_page2;
  SELECT count(DISTINCT id) INTO v_cnt FROM (
    SELECT elem->>'id' AS id FROM jsonb_array_elements(v_page1->'items') elem
    UNION ALL SELECT elem->>'id' AS id FROM jsonb_array_elements(v_page2->'items') elem) sub;
  ASSERT v_cnt = jsonb_array_length(v_res->'items'), 'paged union != full set';
  RAISE NOTICE 'PASS 8 counts/pagination consistent';

  -- 9 同毫秒不同微秒游标不丢行（last_ts 保留微秒，比较用完整精度）
  SELECT handheld_work_items(u_b, ARRAY[loc], false, 1, '2026-10-22 10:59:59+00', gen_random_uuid()) INTO v_page1;
  v_ts := v_page1->>'last_ts';
  ASSERT v_ts LIKE '%.______.____%' OR v_ts ~ '\.\d{6}', 'last_ts lost microseconds: ' || coalesce(v_ts,'null');
  SELECT handheld_work_items(u_b, ARRAY[loc], false, 10, v_ts::timestamptz, (v_page1->>'last_id')::uuid) INTO v_page2;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_page2->'items') i WHERE i->>'id' = t2::text), 'same-ms row skipped by cursor';
  RAISE NOTICE 'PASS 9 microsecond cursor keeps rows';

  -- 10 投影幂等去重：同一失败队列投影两次仍只有一条通知
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, attempts, last_error, created_at)
    VALUES (q1, sku, shop, loc, 'failed', 5, 'token=abcdef1234567890abcdef1234567890 see https://signed.example.com/x?sig=1 call 13800001111', now());
  PERFORM handheld_sync_failure_project('stock', q1);
  PERFORM handheld_sync_failure_project('stock', q1);
  SELECT count(*) INTO v_cnt FROM inv_handheld_notifications WHERE kind='youzan_sync_failed' AND ref_id = q1;
  ASSERT v_cnt = 1, 'projection duplicated';
  RAISE NOTICE 'PASS 10 projection idempotent';

  -- 11 脱敏：URL/长 token/电话号码不进入 payload
  ASSERT (SELECT payload->>'reason' FROM inv_handheld_notifications WHERE ref_id = q1)
       NOT SIMILAR TO '%(https?://%|abcdef1234567890%|13800001111)%', 'masking leaked raw error';
  RAISE NOTICE 'PASS 11 masking strips secrets';

  -- 12 恢复只认真实终态：running 不恢复，done 恢复
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, created_at)
    VALUES (q2, sku, shop, loc, 'failed', now()), (q3, sku, shop, loc, 'failed', now());
  PERFORM handheld_sync_failure_project('stock', q2);
  PERFORM handheld_sync_failure_project('stock', q3);
  UPDATE youzan_stock_sync_queue SET status='running' WHERE id=q2;
  UPDATE youzan_stock_sync_queue SET status='done' WHERE id=q3;
  PERFORM handheld_sync_failure_reconcile(7, 100);
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=q2) IS NULL, 'running marked recovered';
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=q3) = 'recovered', 'done not recovered';
  RAISE NOTICE 'PASS 12 recovery only on terminal done';

  -- 13 reconcile 不把仍 failed 的队列误标恢复
  PERFORM handheld_sync_failure_reconcile(7, 100);
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=q1) IS NULL, 'failed marked recovered';
  RAISE NOTICE 'PASS 13 reconcile keeps failed pending';

  -- 14 location_id 为 NULL + shop 唯一映射 → 投影到该门店（min(l.id::text)::uuid 不报错）
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, created_at)
    VALUES (q4, sku, shop, NULL, 'failed', now());
  PERFORM handheld_sync_failure_project('stock', q4);
  ASSERT (SELECT location_id FROM inv_handheld_notifications WHERE ref_id=q4) = loc, 'unique shop mapping not resolved';
  RAISE NOTICE 'PASS 14 null location unique shop mapped';

  -- 15 shop 映射 0 家门店 → 不投影（绝不广播）
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, created_at)
    VALUES (gen_random_uuid(), sku, shop0, NULL, 'failed', now());
  PERFORM handheld_sync_failure_project('stock', (SELECT id FROM youzan_stock_sync_queue WHERE shop_id=shop0));
  ASSERT NOT EXISTS(SELECT 1 FROM inv_handheld_notifications n JOIN youzan_stock_sync_queue q ON q.id=n.ref_id WHERE q.shop_id=shop0), 'zero-shop broadcast';
  RAISE NOTICE 'PASS 15 zero-shop not broadcast';

  -- 16 shop 映射多家门店 → 不投影（歧义不广播）
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, created_at)
    VALUES (gen_random_uuid(), sku, shop2, NULL, 'failed', now());
  PERFORM handheld_sync_failure_project('stock', (SELECT id FROM youzan_stock_sync_queue WHERE shop_id=shop2));
  ASSERT NOT EXISTS(SELECT 1 FROM inv_handheld_notifications n JOIN youzan_stock_sync_queue q ON q.id=n.ref_id WHERE q.shop_id=shop2), 'multi-shop broadcast';
  RAISE NOTICE 'PASS 16 multi-shop not broadcast';

  -- 17 location_id 直接给出时优先使用（shop 不匹配也不改投他店）
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, created_at)
    VALUES (gen_random_uuid(), sku, shop2, loc, 'failed', now());
  PERFORM handheld_sync_failure_project('stock', (SELECT id FROM youzan_stock_sync_queue WHERE shop_id=shop2 AND location_id=loc));
  ASSERT (SELECT n.location_id FROM inv_handheld_notifications n JOIN youzan_stock_sync_queue q ON q.id=n.ref_id
          WHERE q.shop_id=shop2 AND q.location_id=loc) IS NULL, 'location/shop mismatch must not project';
  RAISE NOTICE 'PASS 17 location/shop mismatch blocked';
END $$;

ROLLBACK;
