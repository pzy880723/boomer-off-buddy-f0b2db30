\set ON_ERROR_STOP 1
-- 尺寸测量 RPC 行为用例（隔离库）。
DO $$
DECLARE
  r jsonb; r2 jsonb; n int; t uuid; rev int; h numeric;
  sku1 uuid := '00000000-0000-0000-0000-000000000001';
  sku4 uuid := '00000000-0000-0000-0000-000000000004';
  l1 uuid := '00000000-0000-0000-0000-000000000011';
  l2 uuid := '00000000-0000-0000-0000-000000000012';
  l3 uuid := '00000000-0000-0000-0000-000000000013';
  l4 uuid := '00000000-0000-0000-0000-000000000014';
  loc uuid := '00000000-0000-0000-0000-00000000000a';
  loc2 uuid := '00000000-0000-0000-0000-00000000000b';
  c1 uuid := '00000000-0000-0000-0000-000000000021';
  c2 uuid := '00000000-0000-0000-0000-000000000022';
  c3 uuid := '00000000-0000-0000-0000-0000000000ff';
  staff uuid := '00000000-0000-0000-0000-00000000ff01';
BEGIN
  INSERT INTO inv_locations(id, name) VALUES (loc2, '二店') ON CONFLICT DO NOTHING;
  INSERT INTO inv_skus(id, name, location_id) VALUES (sku4, '无任务商品', loc);
  INSERT INTO commerce_listings(id, sku_id, location_id, status, published_at)
    VALUES (l4, sku4, loc, 'published', now());

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
  SELECT count(*) INTO n FROM product_measurement_tasks WHERE sku_id <> sku4;
  ASSERT n = 0, 'no task for measured sku';
  RAISE NOTICE 'PASS measured returns measurement';

  -- 3 首次申请建任务 + 门店手持提醒（含 sku/listing/product_name，无顾客数据）
  r := public.measurement_request(l1, c1);
  ASSERT r->>'status' = 'pending', 'first request pending';
  t := (r->>'task_id')::uuid;
  SELECT count(*) INTO n FROM inv_handheld_notifications
   WHERE kind='measurement_requested' AND ref_type='measurement_task' AND ref_id=t
     AND location_id=loc
     AND payload->>'sku_id' = sku1::text AND payload->>'product_name' = '奥特曼软胶'
     AND payload ? 'customer_id' = false;
  ASSERT n = 1, 'handheld notification created once';
  RAISE NOTICE 'PASS request creates task + store notification';

  -- 4 第二用户合并同一任务，不重复建提醒；重复申请幂等
  r2 := public.measurement_request(l1, c2);
  ASSERT (r2->>'task_id')::uuid = t, 'merged into same task';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE kind='measurement_requested';
  ASSERT n = 1, 'no duplicate store notification';
  r2 := public.measurement_request(l1, c1);
  ASSERT (r2->>'task_id')::uuid = t, 'repeat request idempotent';
  SELECT count(*) INTO n FROM product_measurement_requesters WHERE task_id = t;
  ASSERT n = 2, 'two distinct requesters';
  RAISE NOTICE 'PASS merge + idempotent request';

  -- 5 保存：client_op_id/expected_revision 必填 / 冲突拒绝 / 非法值拒绝
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-null-rev', NULL, loc, 10, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL null revision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%expected_revision_required%', 'required'; END;
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-0001-save', 5, loc, 10, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL wrong revision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%revision_conflict%', 'conflict'; END;
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-0001-save', 0, loc, -1, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL negative accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%invalid_measurement%', 'invalid'; END;
  BEGIN
    PERFORM public.measurement_save(sku1, t, staff, 'op-0001-save', 0, loc, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL empty accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%empty_measurement%', 'empty'; END;
  RAISE NOTICE 'PASS save validation';

  -- 6 正常保存：revision+1、任务完成、手持提醒 handled、两申请者各一条带 product_id 的通知
  r := public.measurement_save(sku1, t, staff, 'op-0001-save', 0, loc, 12.5, 8, NULL, NULL);
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

  -- 7 client_op_id 重放：返回原结果，不再改数据、不再通知（即使内容字段不同也按指纹判）
  r := public.measurement_save(sku1, t, staff, 'op-0001-save', 0, loc, 12.5, 8, NULL, NULL);
  ASSERT (r->>'replayed')::boolean = true, 'replayed';
  ASSERT (r->>'revision')::int = 1, 'replay returns original revision';
  SELECT measurement_height_cm INTO h FROM inv_skus WHERE id = sku1;
  ASSERT h = 12.5, 'replay does not overwrite';
  SELECT count(*) INTO n FROM commerce_customer_notifications WHERE kind='measurement_completed';
  ASSERT n = 2, 'replay does not re-notify';
  RAISE NOTICE 'PASS client_op_id replay';

  -- 8 已完成任务上的新申请：商品已有实测 → completed（不会落入死任务）
  r := public.measurement_request(l1, c1);
  ASSERT r->>'status' = 'completed', 'post-save request completes';
  RAISE NOTICE 'PASS no orphan task after completion';

  -- 9 无任务保存 + 同 op 重放：返回原结果，不重复改数
  r := public.measurement_save(sku4, NULL, staff, 'op-notask', 0, loc, 30, 20, NULL, NULL);
  ASSERT (r->>'revision')::int = 1, 'no-task save works';
  r2 := public.measurement_save(sku4, NULL, staff, 'op-notask', 0, loc, 30, 20, NULL, NULL);
  ASSERT (r2->>'replayed')::boolean = true AND (r2->>'revision')::int = 1, 'no-task replay returns original';
  SELECT measurement_revision INTO rev FROM inv_skus WHERE id = sku4;
  ASSERT rev = 1, 'replay did not bump revision';
  RAISE NOTICE 'PASS no-task save + replay';

  -- 10 同 op 不同内容：op_conflict（409）
  BEGIN
    PERFORM public.measurement_save(sku4, NULL, staff, 'op-notask', 0, loc, 99, 20, NULL, NULL);
    RAISE EXCEPTION 'FAIL op reuse accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%op_conflict%', 'op_conflict raised'; END;
  RAISE NOTICE 'PASS op_conflict on different content';

  -- 11 申请/保存交错：无 task_id 保存仍在锁内完成活跃任务并通知（用未实测的新商品）
  INSERT INTO inv_skus(id, name, location_id) VALUES ('00000000-0000-0000-0000-000000000006', '交错商品', loc);
  INSERT INTO commerce_listings(id, sku_id, location_id, status, published_at)
    VALUES ('00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000006', loc, 'published', now());
  r := public.measurement_request('00000000-0000-0000-0000-000000000016', c1);
  t := (r->>'task_id')::uuid;
  r := public.measurement_save('00000000-0000-0000-0000-000000000006', NULL, staff, 'op-interleave', 0, loc, 31, 21, NULL, NULL);
  ASSERT (r->>'task_id')::uuid = t, 'save picked up active task inside lock';
  ASSERT (r->>'notified')::int = 1, 'interleaved requester notified';
  RAISE NOTICE 'PASS request/save interleave completes task';

  -- 12 商品调拨后旧店保存：location_mismatch 拒绝
  UPDATE inv_skus SET location_id = loc2 WHERE id = sku1;
  BEGIN
    PERFORM public.measurement_save(sku1, NULL, staff, 'op-moved', 1, loc, 10, 8, NULL, NULL);
    RAISE EXCEPTION 'FAIL moved sku accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%location_mismatch%', 'transferred sku rejected for old location'; END;
  UPDATE inv_skus SET location_id = loc WHERE id = sku1;
  RAISE NOTICE 'PASS transferred sku rejected';

  -- 13 通知失败整体回滚：revision 不变、任务仍 pending、无幂等记录
  CREATE OR REPLACE FUNCTION public.test_fail_notify() RETURNS trigger LANGUAGE plpgsql AS $t$
  BEGIN
    IF NEW.customer_id = '00000000-0000-0000-0000-0000000000ff' THEN
      RAISE EXCEPTION 'simulated notify failure';
    END IF;
    RETURN NEW;
  END $t$;
  CREATE TRIGGER fail_notify BEFORE INSERT ON commerce_customer_notifications
    FOR EACH ROW EXECUTE FUNCTION public.test_fail_notify();
  INSERT INTO commerce_customers(id) VALUES (c3);
  r := public.measurement_request(l1, c3);  -- sku1 已实测 → completed，改用 sku4 无任务？sku4 已有实测。新建独立商品
  INSERT INTO inv_skus(id, name, location_id) VALUES ('00000000-0000-0000-0000-000000000005', '回滚商品', loc);
  INSERT INTO commerce_listings(id, sku_id, location_id, status, published_at)
    VALUES ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000005', loc, 'published', now());
  r := public.measurement_request('00000000-0000-0000-0000-000000000015', c3);
  t := (r->>'task_id')::uuid;
  BEGIN
    PERFORM public.measurement_save('00000000-0000-0000-0000-000000000005', t, staff, 'op-failnotify', 0, loc, 10, 8, NULL, NULL);
    RAISE EXCEPTION 'FAIL notify failure swallowed';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM LIKE '%simulated notify failure%', 'notify failure propagated';
  END;
  SELECT measurement_revision INTO rev FROM inv_skus WHERE id = '00000000-0000-0000-0000-000000000005';
  ASSERT rev = 0, 'revision rolled back on notify failure';
  ASSERT (SELECT status FROM product_measurement_tasks WHERE id = t) = 'pending', 'task rolled back';
  ASSERT NOT EXISTS (SELECT 1 FROM measurement_mutations WHERE client_op_id = 'op-failnotify'), 'mutation record rolled back';
  DROP TRIGGER fail_notify ON commerce_customer_notifications;
  DROP FUNCTION public.test_fail_notify();
  RAISE NOTICE 'PASS notify failure rolls back';
END $$;

-- 素材登记 RPC（measurement_asset_register）用例
DO $$
DECLARE
  r jsonb; r2 jsonb;
  s uuid := '00000000-0000-0000-0000-000000000006';
  loc uuid := '00000000-0000-0000-0000-00000000000a';
  loc2 uuid := '00000000-0000-0000-0000-00000000000b';
  staff uuid := '00000000-0000-0000-0000-00000000ff01';
  outsider uuid := '00000000-0000-0000-0000-00000000ff02';
  hq uuid := '00000000-0000-0000-0000-00000000ff09';
  bb jsonb := '{"x":0,"y":0,"w":100,"h":200}';
  h1 text := 'aaaaaaaaaaaaaaaa'; h2 text := 'bbbbbbbbbbbbbbbb';
  p1 text; p2 text;
BEGIN
  INSERT INTO inv_skus(id, name, location_id) VALUES (s, '素材商品', loc);
  PERFORM public.measurement_save(s, NULL, staff, 'op-asset-save1', 0, loc, 20, 10, NULL, NULL);
  p1 := 'sku-listing/measurements/' || s || '/1-' || h1 || '-640.png';
  p2 := 'sku-listing/measurements/' || s || '/1-' || h2 || '-640.png';

  -- A1 跨店 actor（无该店权限）拒绝，且不落 ready
  BEGIN
    PERFORM public.measurement_asset_register(s, outsider, 'op-img-out01', loc, 1, 20, 10, h1, p1, bb, 100, 200, 10);
    RAISE EXCEPTION 'FAIL outsider registered';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%unauthorized_role%', 'outsider rejected: ' || SQLERRM; END;
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_assets WHERE sku_id = s), 'no asset after outsider';
  RAISE NOTICE 'PASS asset register rejects cross-store actor';

  -- A2 旧版本 / 实测宽高不一致 拒绝
  BEGIN
    PERFORM public.measurement_asset_register(s, staff, 'op-img-old01', loc, 2, 20, 10, h1,
      'sku-listing/measurements/' || s || '/2-' || h1 || '-640.png', bb, 100, 200, 10);
    RAISE EXCEPTION 'FAIL stale revision registered';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%revision_conflict%', 'wrong revision rejected: ' || SQLERRM; END;
  BEGIN
    PERFORM public.measurement_asset_register(s, staff, 'op-img-geo01', loc, 1, 20, 12, h1, p1, bb, 100, 200, 10);
    RAISE EXCEPTION 'FAIL geometry mismatch registered';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%revision_conflict%', 'measured size mismatch rejected'; END;
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_assets WHERE sku_id = s), 'no asset after stale';
  RAISE NOTICE 'PASS asset register rejects stale revision and size mismatch';

  -- A3 他品/非规范路径拒绝
  BEGIN
    PERFORM public.measurement_asset_register(s, staff, 'op-img-path1', loc, 1, 20, 10, h1,
      'sku-listing/measurements/00000000-0000-0000-0000-000000000001/1-' || h1 || '-640.png', bb, 100, 200, 10);
    RAISE EXCEPTION 'FAIL foreign path registered';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%invalid_asset%', 'foreign path rejected'; END;
  RAISE NOTICE 'PASS asset register rejects foreign path';

  -- A4 正常登记 → ready；同 op 同图回放；同 op 换图 op_conflict
  r := public.measurement_asset_register(s, staff, 'op-img-ok001', loc, 1, 20, 10, h1, p1, bb, 100, 200, 10);
  ASSERT r->>'status' = 'ready' AND (r->>'revision')::int = 1 AND (r->>'replayed')::boolean = false, 'registered';
  ASSERT (SELECT status = 'ready' AND verified AND cutout_preview_path = p1 FROM product_measurement_assets WHERE sku_id = s AND revision = 1), 'asset ready';
  r2 := public.measurement_asset_register(s, staff, 'op-img-ok001', loc, 1, 20, 10, h1, p1, bb, 100, 200, 10);
  ASSERT (r2->>'replayed')::boolean = true AND r2->>'cutout_preview_path' = p1, 'replayed';
  BEGIN
    PERFORM public.measurement_asset_register(s, staff, 'op-img-ok001', loc, 1, 20, 10, h2, p2, bb, 100, 200, 10);
    RAISE EXCEPTION 'FAIL op reuse accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%op_conflict%', 'op reuse rejected'; END;
  RAISE NOTICE 'PASS asset register idempotent replay and op_conflict';

  -- A5 不同图争抢同 revision：first-write-wins，新 op 换图 image_conflict，原图不被覆盖
  BEGIN
    PERFORM public.measurement_asset_register(s, hq, 'op-img-other', loc, 1, 20, 10, h2, p2, bb, 100, 200, 10);
    RAISE EXCEPTION 'FAIL overwrite accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%image_conflict%', 'second image rejected: ' || SQLERRM; END;
  ASSERT (SELECT cutout_preview_path FROM product_measurement_assets WHERE sku_id = s AND revision = 1) = p1, 'first image kept';
  RAISE NOTICE 'PASS asset register first-write-wins image_conflict';

  -- A6 商品调店后旧店登记拒绝（HQ actor 通过权限，仍因 location 拒绝）
  PERFORM public.measurement_save(s, NULL, staff, 'op-asset-save2', 1, loc, 30, 10, NULL, NULL);
  UPDATE inv_skus SET location_id = loc2 WHERE id = s;
  BEGIN
    PERFORM public.measurement_asset_register(s, hq, 'op-img-moved', loc, 2, 30, 10, h1,
      'sku-listing/measurements/' || s || '/2-' || h1 || '-640.png', bb, 100, 300, 10);
    RAISE EXCEPTION 'FAIL moved sku registered';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%location_mismatch%', 'moved sku rejected: ' || SQLERRM; END;
  BEGIN
    PERFORM public.measurement_asset_register(s, staff, 'op-img-moved2', loc2, 2, 30, 10, h1,
      'sku-listing/measurements/' || s || '/2-' || h1 || '-640.png', bb, 100, 300, 10);
    RAISE EXCEPTION 'FAIL old-store staff registered on new store';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM LIKE '%unauthorized_role%', 'old-store staff lacks new-store perm'; END;
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_assets WHERE sku_id = s AND revision = 2), 'no rev2 asset';
  UPDATE inv_skus SET location_id = loc WHERE id = s;
  RAISE NOTICE 'PASS asset register rejects transferred sku';
END $$;
