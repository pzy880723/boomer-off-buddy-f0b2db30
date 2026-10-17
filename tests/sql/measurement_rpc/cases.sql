\set ON_ERROR_STOP 1
-- 尺寸测量 RPC 行为用例（隔离库）。
DO $$
DECLARE
  r jsonb; r2 jsonb; n int; t uuid; rev int;
  sku1 uuid := '00000000-0000-0000-0000-0000000000s1';
  l1 uuid := '00000000-0000-0000-0000-0000000000L1';
  l2 uuid := '00000000-0000-0000-0000-0000000000L2';
  l3 uuid := '00000000-0000-0000-0000-0000000000L3';
  c1 uuid := '00000000-0000-0000-0000-0000000000c1';
  c2 uuid := '00000000-0000-0000-0000-0000000000c2';
  staff uuid := '00000000-0000-0000-0000-00000000ff01';
BEGIN
  -- 1 草稿商品不可申请
  BEGIN
    PERFORM public.measurement_request(l3, c1);
    RAISE EXCEPTION 'FAIL draft accepted';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%not_found%', 'draft must be not_found';
  END;
  RAISE NOTICE 'PASS draft rejected';

  -- 2 已有实测：completed + 完整 measurement，不建任务
  r := public.measurement_request(l2, c1);
  ASSERT r->>'status' = 'completed', 'measured sku completes';
  ASSERT (r->'measurement'->>'height_cm')::numeric = 10, 'measurement returned';
  ASSERT (r->'measurement'->>'revision')::int = 1, 'revision returned';
  SELECT count(*) INTO n FROM product_measurement_tasks;
  ASSERT n = 0, 'no task for measured sku';
  RAISE NOTICE 'PASS measured returns measurement';

  -- 3 首次申请建任务 + 门店手持提醒（含 sku/listing/product_name，无顾客数据）
  r := public.measurement_request(l1, c1);
  ASSERT r->>'status' = 'pending', 'first request pending';
  t := (r->>'task_id')::uuid;
  SELECT count(*) INTO n FROM inv_handheld_notifications
   WHERE kind='measurement_requested' AND ref_type='measurement_task' AND ref_id=t
     AND location_id='00000000-0000-0000-0000-00000000000a'
     AND payload->>'sku_id' = sku1::text AND payload->>'product_name' = '奥特曼软胶'
     AND payload ? 'customer_id' = false;
  ASSERT n = 1, 'handheld notification created once';
  RAISE NOTICE 'PASS request creates task + store notification';

  -- 4 第二用户合并同一任务，不重复建提醒
  r2 := public.measurement_request(l1, c2);
  ASSERT (r2->>'task_id')::uuid = t, 'merged into same task';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE kind='measurement_requested';
  ASSERT n = 1, 'no duplicate store notification';
  -- 重复申请幂等
  r2 := public.measurement_request(l1, c1);
  ASSERT (r2->>'task_id')::uuid = t, 'repeat request idempotent';
  SELECT count(*) INTO n FROM product_measurement_requesters WHERE task_id = t;
  ASSERT n = 2, 'two distinct requesters';
  RAISE NOTICE 'PASS merge + idempotent request';

  -- 5 保存：expected_revision 必填 / 冲突拒绝 / 非法值拒绝
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-1', NULL, 10, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL null revision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%expected_revision_required%', 'required'; END;
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-1', 5, 10, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL wrong revision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%revision_conflict%', 'conflict'; END;
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-1', 0, -1, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL negative accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%invalid_measurement%', 'invalid'; END;
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-1', 0, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL empty accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%empty_measurement%', 'empty'; END;
  RAISE NOTICE 'PASS save validation';

  -- 6 正常保存：revision+1、任务完成、手持提醒 handled、两申请者各一条带 product_id 的通知
  r := public.measurement_save(sku1, t, staff, 'op-1', 0, 12.5, 8, NULL, NULL);
  ASSERT (r->>'revision')::int = 1, 'revision bumped';
  ASSERT (r->>'notified')::int = 2, 'both requesters notified';
  ASSERT (r->>'replayed')::boolean = false, 'not replay';
  SELECT count(*) INTO n FROM commerce_customer_notifications
   WHERE kind='measurement_completed' AND product_id = l1;
  ASSERT n = 2, 'customer notifications carry product_id';
  SELECT count(*) INTO n FROM inv_handheld_notifications
   WHERE kind='measurement_requested' AND action_status='handled';
  ASSERT n = 1, 'store notification handled';
  SELECT measurement_revision INTO rev FROM inv_skus WHERE id = sku1;
  ASSERT rev = 1, 'sku revision 1';
  RAISE NOTICE 'PASS save completes + notifies';

  -- 7 client_op_id 重放：不再改数据、不再通知
  r := public.measurement_save(sku1, t, staff, 'op-1', 1, 99, NULL, NULL, NULL);
  ASSERT (r->>'replayed')::boolean = true, 'replayed';
  SELECT measurement_height_cm INTO n FROM inv_skus WHERE id = sku1;
  ASSERT n = 12.5, 'replay does not overwrite';
  SELECT count(*) INTO n FROM commerce_customer_notifications WHERE kind='measurement_completed';
  ASSERT n = 2, 'replay does not re-notify';
  RAISE NOTICE 'PASS client_op_id replay';

  -- 8 已完成任务上的新申请：商品已有实测 → completed（不会落入死任务）
  r := public.measurement_request(l1, c1);
  ASSERT r->>'status' = 'completed', 'post-save request completes';
  RAISE NOTICE 'PASS no orphan task after completion';
END $$;
