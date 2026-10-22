-- scoped 待办回归：系统分支移除、测量逐任务忽略、客服/业务 scope 独立。每步 DO+ASSERT，失败即 ERROR。
-- 运行：bash tests/sql/handheld_work_items/run.sh（本地临时集群，绝不连生产库）。
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  u_staff uuid := gen_random_uuid();   -- 通用业务权限在 A 店
  u_support uuid := gen_random_uuid(); -- 客服权限在 B 店（无业务权限）
  loc_a uuid := gen_random_uuid(); loc_b uuid := gen_random_uuid();
  shop_a uuid := gen_random_uuid();
  sku uuid := gen_random_uuid();
  t_card uuid := gen_random_uuid();    -- B 店带客服卡的测量任务
  t_orphan uuid := gen_random_uuid();  -- B 店孤立测量任务
  t_a uuid := gen_random_uuid();       -- A 店测量任务
  conv uuid := gen_random_uuid();      -- B 店客服会话（带卡 + 普通待回复）
  cust uuid := gen_random_uuid();
  v_ver timestamptz; v_res jsonb; v_cnt int;
BEGIN
  INSERT INTO inv_locations(id, shop_id, is_active) VALUES (loc_a, shop_a, true), (loc_b, gen_random_uuid(), true);
  INSERT INTO inv_skus(id, name) VALUES (sku, 'scoped回归商品');
  INSERT INTO product_measurement_tasks(id, sku_id, location_id, status, created_at) VALUES
    (t_card, sku, loc_b, 'pending', '2026-10-22 09:00:00+00'),
    (t_orphan, sku, loc_b, 'pending', '2026-10-22 09:05:00+00'),
    (t_a, sku, loc_a, 'pending', '2026-10-22 09:10:00+00');
  INSERT INTO support_conversations(id, location_id, customer_id, title, waiting_since)
    VALUES (conv, loc_b, cust, 'B店尺寸咨询', '2026-10-22 09:01:00+00');
  INSERT INTO product_measurement_requesters(task_id, customer_id, conversation_id, created_at)
    VALUES (t_card, cust, conv, '2026-10-22 09:00:00.123456+00');
  INSERT INTO support_messages(conversation_id, sender_type, measurement_task_id, card_kind, created_at)
    VALUES (conv, 'system', t_card, 'measurement_request', '2026-10-22 09:00:00.123456+00');
  -- 系统同步失败队列存在：scoped 待办不得再出现 system 行
  INSERT INTO youzan_stock_sync_queue(id, sku_id, shop_id, location_id, status, attempts, created_at)
    VALUES (gen_random_uuid(), sku, shop_a, loc_a, 'failed', 5, now());
  INSERT INTO channel_sync_outbox(id, sku_id, shop_id, status, attempts, created_at)
    VALUES (gen_random_uuid(), sku, shop_a, 'failed', 3, now());

  -- S1 系统异常分支已移除：A 店员工待办无 system 行且 counts.system=0
  SELECT handheld_work_items_scoped(u_staff, ARRAY[loc_a], false, 50) INTO v_res;
  ASSERT (v_res->'counts'->>'system')::int = 0, 'system count not zero';
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                    WHERE i->>'type' IN ('stock_sync','channel_sync')), 'system rows still listed';
  RAISE NOTICE 'PASS S1 system branches removed';

  -- S2 带卡测量对 support-B-only 账号可见（measurement 行，回带 conversation_id 与忽略元数据）
  SELECT handheld_work_items_scoped(u_support, '{}'::uuid[], false, 50, NULL, NULL, ARRAY[loc_b], false) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'measurement_task_id' = t_card::text
                  AND i->>'conversation_id' = conv::text
                  AND (i->>'can_ignore')::boolean
                  AND i->>'measurement_request_version' IS NOT NULL), 'carded measurement invisible to support scope';
  RAISE NOTICE 'PASS S2 carded measurement visible via support scope';

  -- S3 孤立测量对 support-B-only 账号不泄漏；support 行（普通待回复）仍可见
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                    WHERE i->>'measurement_task_id' = t_orphan::text), 'orphan measurement leaked to support-only';
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'type' = 'support' AND i->>'id' = conv::text), 'plain needs_reply support row missing';
  RAISE NOTICE 'PASS S3 orphan not leaked, plain reply kept';

  -- S4 general-A 员工看不到 B 店任何测量/会话
  SELECT handheld_work_items_scoped(u_staff, ARRAY[loc_a], false, 50) INTO v_res;
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                    WHERE i->>'measurement_task_id' IN (t_card::text, t_orphan::text)
                       OR i->>'conversation_id' = conv::text), 'cross-store leak to general A';
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'measurement_task_id' = t_a::text), 'own store measurement missing';
  RAISE NOTICE 'PASS S4 no cross-store leak';

  -- S5 带卡测量忽略：仅该测量行消失，同会话普通待回复 support 行保留
  v_ver := measurement_task_request_version(t_card);
  PERFORM measurement_task_dismiss(t_card, u_support, loc_b, v_ver);
  SELECT handheld_work_items_scoped(u_support, '{}'::uuid[], false, 50, NULL, NULL, ARRAY[loc_b], false) INTO v_res;
  ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                    WHERE i->>'measurement_task_id' = t_card::text), 'dismissed carded row still visible';
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'type' = 'support' AND i->>'id' = conv::text), 'mixed plain reply swallowed by dismiss';
  RAISE NOTICE 'PASS S5 dismiss hides only the measurement row';

  -- S6 撤销忽略恢复；ignored_only 下该行可见且 can_restore
  PERFORM measurement_task_undismiss(t_card, u_support, loc_b, v_ver);
  SELECT handheld_work_items_scoped(u_support, '{}'::uuid[], false, 50, NULL, NULL, ARRAY[loc_b], false) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'measurement_task_id' = t_card::text), 'undismiss did not restore';
  PERFORM measurement_task_dismiss(t_card, u_support, loc_b, v_ver);
  SELECT handheld_work_items_scoped(u_support, '{}'::uuid[], false, 50, NULL, NULL, ARRAY[loc_b], false, false, true) INTO v_res;
  ASSERT jsonb_array_length(v_res->'items') = 1
     AND (v_res->'items'->0->>'can_restore')::boolean
     AND v_res->'items'->0->>'measurement_task_id' = t_card::text, 'ignored_only contract broken';
  RAISE NOTICE 'PASS S6 undismiss restores, ignored_only restorable';

  -- S7 同 task 新 requester 版本 → 重新出现（旧忽略不吞新请求）
  INSERT INTO product_measurement_requesters(task_id, customer_id, conversation_id, created_at)
    VALUES (t_card, gen_random_uuid(), conv, '2026-10-22 10:00:00.654321+00');
  SELECT handheld_work_items_scoped(u_support, '{}'::uuid[], false, 50, NULL, NULL, ARRAY[loc_b], false) INTO v_res;
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(v_res->'items') i
                WHERE i->>'measurement_task_id' = t_card::text AND NOT (i->>'ignored')::boolean),
        'new requester version swallowed';
  RAISE NOTICE 'PASS S7 new version reappears';

  -- S8 旧 8 参调用兼容（默认不含已忽略）且与 pending_counts_scoped 计数一致
  SELECT handheld_work_items_scoped(u_support, '{}'::uuid[], false, 50, NULL, NULL, ARRAY[loc_b], false) INTO v_res;
  ASSERT v_res->'counts' = handheld_pending_counts_scoped(u_support, '{}'::uuid[], false, ARRAY[loc_b], false),
        'count stream mismatch';
  SELECT count(*) INTO v_cnt FROM jsonb_array_elements(v_res->'items') i WHERE i->>'type' = 'support';
  ASSERT v_cnt = 1, 'unexpected support rows';
  RAISE NOTICE 'PASS S8 legacy 8-arg compat and count consistency';

  -- S9 新签名仅 service_role 可执行
  ASSERT NOT has_function_privilege('anon',
    'public.handheld_work_items_scoped(uuid,uuid[],boolean,integer,timestamptz,uuid,uuid[],boolean,boolean,boolean)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated',
    'public.handheld_work_items_scoped(uuid,uuid[],boolean,integer,timestamptz,uuid,uuid[],boolean,boolean,boolean)', 'EXECUTE');
  ASSERT has_function_privilege('service_role',
    'public.handheld_work_items_scoped(uuid,uuid[],boolean,integer,timestamptz,uuid,uuid[],boolean,boolean,boolean)', 'EXECUTE');
  RAISE NOTICE 'PASS S9 service-only grants on new signature';
END $$;

ROLLBACK;
