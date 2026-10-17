\set ON_ERROR_STOP 1
-- 尺寸测量 RPC 行为用例（隔离库，表结构=实际库裁剪；inv_skus 无 location_id，门店以 inv_stocks 正库存为准）
-- 员工 st('1')=仅A店，st('2')=仅B店，st('9')=总部

-- 0 结构护栏：inv_skus 不得有 location_id
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_skus' AND column_name='location_id'), 'inv_skus must not have location_id';
  RAISE NOTICE 'PASS inv_skus has no location_id';
END $$;

-- 1 草稿不可申请；已测直接 completed
DO $$ DECLARE r jsonb; BEGIN
  PERFORM test_mk(90,'a','a=1');
  UPDATE commerce_listings SET status='draft', published_at=NULL WHERE id=l(90);
  PERFORM test_expect_err(format('select measurement_request(%L,%L)', l(90), cu(1)), 'not_found');
  PERFORM test_mk(91,'a','a=1');
  UPDATE inv_skus SET measurement_height_cm=10, measured_at=now(), measurement_revision=1 WHERE id=s(91);
  r := measurement_request(l(91), cu(1));
  ASSERT r->>'status'='completed' AND (r->'measurement'->>'height_cm')::numeric=10, 'measured completes';
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id=s(91)), 'no task for measured';
  RAISE NOTICE 'PASS draft rejected + measured returns completed';
END $$;

-- 2 A0B1：listing 归 A 但只有 B 有货 → 任务/提醒转 B；A 店员工与总部在 A 都不能保存；B 店保存通过
DO $$ DECLARE r jsonb; t uuid; BEGIN
  PERFORM test_mk(1,'a','a=0,b=1');
  r := measurement_request(l(1), cu(1));
  ASSERT r->>'status'='pending', 'A0B1 pending';
  t := (r->>'task_id')::uuid;
  ASSERT (SELECT location_id FROM product_measurement_tasks WHERE id=t)=loc('b'), 'task at B';
  ASSERT (SELECT count(*) FROM inv_handheld_notifications WHERE ref_id=t AND location_id=loc('b') AND action_status IS NULL
          AND kind='measurement_requested' AND payload->>'sku_id'=s(1)::text AND NOT payload ? 'customer_id')=1, 'one notif at B';
  ASSERT (SELECT count(*) FROM inv_handheld_notifications WHERE ref_id=t AND location_id=loc('a'))=0, 'none at A';
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,10,5,null,null)', s(1), st('1'), 'op-a0b1-a', loc('a')), 'location_mismatch');
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,10,5,null,null)', s(1), st('9'), 'op-a0b1-hq', loc('a')), 'location_mismatch');
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,10,5,null,null)', s(1), st('1'), 'op-a0b1-ab', loc('b')), 'unauthorized_role');
  r := measurement_save(s(1), null, st('2'), 'op-a0b1-b', 0, loc('b'), 10, 5, null, null);
  ASSERT (r->>'revision')::int=1 AND (r->>'task_id')::uuid=t AND (r->>'notified')::int=1, 'B save completes task';
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=t)='handled', 'notif handled';
  ASSERT (SELECT count(*) FROM commerce_customer_notifications WHERE customer_id=cu(1) AND kind='measurement_completed')=1, 'customer notified';
  RAISE NOTICE 'PASS A0B1 old store rejected, new store passes';
END $$;

-- 3 A1B1 标准多店：listing 店有货→归 listing 店；listing 店无货且多店有货→不随机串店，unavailable
DO $$ DECLARE r jsonb; BEGIN
  PERFORM test_mk(2,'a','a=1,b=1');
  r := measurement_request(l(2), cu(1));
  ASSERT (SELECT location_id FROM product_measurement_tasks WHERE id=(r->>'task_id')::uuid)=loc('a'), 'A1B1 stays at listing store A';
  PERFORM test_mk(3,'c','a=1,b=1');
  r := measurement_request(l(3), cu(1));
  ASSERT r->>'status'='unavailable' AND r->>'task_id' IS NULL, 'ambiguous multi-store unavailable';
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id=s(3)), 'no task';
  ASSERT NOT EXISTS (SELECT 1 FROM inv_handheld_notifications WHERE payload->>'sku_id'=s(3)::text), 'no broadcast';
  RAISE NOTICE 'PASS A1B1 multi-store no misattribution';
END $$;

-- 4 无正库存：unavailable + 中文提示，不建任务/不广播/不记申请者
DO $$ DECLARE r jsonb; BEGIN
  PERFORM test_mk(4,'a','a=0');
  r := measurement_request(l(4), cu(1));
  ASSERT r->>'status'='unavailable' AND r->>'message' LIKE '%联系门店%', 'unavailable chinese';
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id=s(4)), 'no task';
  ASSERT NOT EXISTS (SELECT 1 FROM inv_handheld_notifications WHERE payload->>'sku_id'=s(4)::text), 'no notif';
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_requesters r JOIN product_measurement_tasks t ON t.id=r.task_id WHERE t.sku_id=s(4)), 'no requester';
  RAISE NOTICE 'PASS no stock unavailable without fake notify';
END $$;

-- 5 同事务调拨 A1→A0、B0→B1：提交时按最终库存转派，申请者不丢、领取清空、一条提醒在 B
DO $$ DECLARE r jsonb; BEGIN
  PERFORM test_mk(5,'a','a=1,b=0');
  r := measurement_request(l(5), cu(1));
  PERFORM measurement_request(l(5), cu(2));
  UPDATE product_measurement_tasks SET status='claimed', claimed_by=st('1'), claimed_at=now() WHERE sku_id=s(5);
END $$;
BEGIN;
UPDATE inv_stocks SET qty=0 WHERE sku_id=s(5) AND location_id=loc('a');
DO $$ BEGIN
  ASSERT (SELECT location_id FROM product_measurement_tasks WHERE sku_id=s(5) AND status IN ('pending','claimed'))=loc('a'), 'not yet moved mid-txn (deferred)';
END $$;
UPDATE inv_stocks SET qty=1 WHERE sku_id=s(5) AND location_id=loc('b');
COMMIT;
DO $$ DECLARE t product_measurement_tasks%ROWTYPE; BEGIN
  SELECT * INTO t FROM product_measurement_tasks WHERE sku_id=s(5) AND status IN ('pending','claimed');
  ASSERT FOUND, 'task still active';
  ASSERT t.location_id=loc('b') AND t.status='pending' AND t.claimed_by IS NULL AND t.claimed_at IS NULL, 'moved to B, claim cleared';
  ASSERT (SELECT count(*) FROM product_measurement_requesters WHERE task_id=t.id)=2, 'requesters kept';
  ASSERT (SELECT count(*) FROM inv_handheld_notifications WHERE ref_id=t.id)=1, 'one notif';
  ASSERT (SELECT location_id FROM inv_handheld_notifications WHERE ref_id=t.id)=loc('b'), 'notif at B';
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=t.id) IS NULL, 'notif open';
  RAISE NOTICE 'PASS same-txn transfer A0B1 keeps requesters, one notif at new store';
END $$;

-- 6 跨事务无库存：挂起（提醒 paused，不广播），新申请 unavailable；库存到店后转派恢复
DO $$ DECLARE r jsonb; t uuid; BEGIN
  PERFORM test_mk(6,'a','a=1');
  r := measurement_request(l(6), cu(1));
  t := (r->>'task_id')::uuid;
END $$;
UPDATE inv_stocks SET qty=0 WHERE sku_id=s(6) AND location_id=loc('a');
DO $$ DECLARE r jsonb; t uuid; BEGIN
  SELECT id INTO t FROM product_measurement_tasks WHERE sku_id=s(6) AND status='pending';
  ASSERT t IS NOT NULL, 'task suspended not cancelled';
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=t)='paused', 'notif paused';
  ASSERT (SELECT count(*) FROM inv_handheld_notifications WHERE ref_id=t)=1, 'no extra notif';
  r := measurement_request(l(6), cu(2));
  ASSERT r->>'status'='unavailable', 'request while suspended unavailable';
  ASSERT (SELECT count(*) FROM product_measurement_requesters WHERE task_id=t)=1, 'original requester only';
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,10,5,null,null)', s(6), st('9'), 'op-susp-hq', loc('a')), 'location_mismatch');
  RAISE NOTICE 'PASS no stock suspends without broadcast';
END $$;
INSERT INTO inv_stocks (sku_id, location_id, qty) VALUES (s(6), loc('b'), 1);
DO $$ DECLARE t uuid; BEGIN
  SELECT id INTO t FROM product_measurement_tasks WHERE sku_id=s(6) AND status='pending';
  ASSERT (SELECT location_id FROM product_measurement_tasks WHERE id=t)=loc('b'), 'task moved to B';
  ASSERT (SELECT location_id FROM inv_handheld_notifications WHERE ref_id=t)=loc('b'), 'notif moved';
  ASSERT (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=t) IS NULL, 'notif resumed';
  ASSERT (SELECT count(*) FROM inv_handheld_notifications WHERE ref_id=t)=1, 'still one notif';
  ASSERT (SELECT count(*) FROM product_measurement_requesters WHERE task_id=t)=1, 'requester kept';
  RAISE NOTICE 'PASS stock arrives: reassigned + resumed';
END $$;

-- 7 同店恢复：A 归零后同店再到货 → 原店恢复
DO $$ BEGIN PERFORM test_mk(7,'a','a=1'); PERFORM measurement_request(l(7), cu(1)); END $$;
UPDATE inv_stocks SET qty=0 WHERE sku_id=s(7);
UPDATE inv_stocks SET qty=2 WHERE sku_id=s(7);
DO $$ DECLARE t uuid; BEGIN
  SELECT id INTO t FROM product_measurement_tasks WHERE sku_id=s(7) AND status='pending';
  ASSERT (SELECT location_id FROM inv_handheld_notifications WHERE ref_id=t)=loc('a')
     AND (SELECT action_status FROM inv_handheld_notifications WHERE ref_id=t) IS NULL, 'resumed at A';
  RAISE NOTICE 'PASS same-store restock resumes';
END $$;

-- 8 合并与幂等申请：同任务一条提醒，两个申请者
DO $$ DECLARE r1 jsonb; r2 jsonb; BEGIN
  PERFORM test_mk(8,'a','a=1');
  r1 := measurement_request(l(8), cu(1));
  r2 := measurement_request(l(8), cu(2));
  PERFORM measurement_request(l(8), cu(1));
  ASSERT r1->>'task_id' = r2->>'task_id', 'merged';
  ASSERT (SELECT count(*) FROM inv_handheld_notifications WHERE payload->>'sku_id'=s(8)::text)=1, 'one notif';
  ASSERT (SELECT count(*) FROM product_measurement_requesters WHERE task_id=(r1->>'task_id')::uuid)=2, 'two requesters';
  RAISE NOTICE 'PASS merge + idempotent request';
END $$;

-- 9 保存幂等：同 op 同内容回放；同 op 改内容 op_conflict；旧 revision revision_conflict；输入校验
DO $$ DECLARE r jsonb; BEGIN
  PERFORM test_mk(9,'a','a=1');
  r := measurement_save(s(9), null, st('1'), 'op-idem-0001', 0, loc('a'), 12, 6, null, null);
  ASSERT (r->>'revision')::int=1 AND r->>'task_id' IS NULL, 'no-task save';
  r := measurement_save(s(9), null, st('1'), 'op-idem-0001', 0, loc('a'), 12, 6, null, null);
  ASSERT (r->>'replayed')::boolean AND (r->>'revision')::int=1, 'replay';
  ASSERT (SELECT measurement_revision FROM inv_skus WHERE id=s(9))=1, 'revision not bumped by replay';
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,13,6,null,null)', s(9), st('1'), 'op-idem-0001', loc('a')), 'op_conflict');
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,13,6,null,null)', s(9), st('1'), 'op-idem-0002', loc('a')), 'revision_conflict');
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,1,%L,-1,6,null,null)', s(9), st('1'), 'op-idem-0003', loc('a')), 'invalid_measurement');
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,1,%L,null,null,null,null)', s(9), st('1'), 'op-idem-0004', loc('a')), 'empty_measurement');
  ASSERT (SELECT location_id FROM measurement_mutations WHERE client_op_id='op-idem-0001')=loc('a'), 'mutation records store';
  RAISE NOTICE 'PASS save idempotency + conflicts';
END $$;

-- 10 通知失败整体回滚：尺寸/任务都不变
CREATE FUNCTION public.test_fail_notif() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'boom_notif'; END $f$;
CREATE TRIGGER test_fail_notif BEFORE INSERT ON commerce_customer_notifications FOR EACH ROW EXECUTE FUNCTION test_fail_notif();
DO $$ BEGIN
  PERFORM test_mk(10,'a','a=1');
  PERFORM measurement_request(l(10), cu(1));
  PERFORM test_expect_err(format('select measurement_save(%L,null,%L,%L,0,%L,10,5,null,null)', s(10), st('1'), 'op-rollback-1', loc('a')), 'boom_notif');
  ASSERT (SELECT measurement_revision FROM inv_skus WHERE id=s(10))=0, 'revision rolled back';
  ASSERT EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id=s(10) AND status='pending'), 'task still pending';
  ASSERT NOT EXISTS (SELECT 1 FROM measurement_mutations WHERE client_op_id='op-rollback-1'), 'no mutation';
  RAISE NOTICE 'PASS notification failure rolls back';
END $$;
DROP TRIGGER test_fail_notif ON commerce_customer_notifications;

-- 11 素材登记：真实正库存 + 权限 + 版本 + op 幂等 + first-write-wins
DO $$ DECLARE r jsonb; p text; p2 text; BEGIN
  PERFORM test_mk(11,'a','a=0,b=1');
  PERFORM measurement_save(s(11), null, st('2'), 'op-asset-save', 0, loc('b'), 20, 10, null, null);
  p  := 'sku-listing/measurements/' || s(11) || '/1-00000000000000aa-640.png';
  p2 := 'sku-listing/measurements/' || s(11) || '/1-00000000000000bb-640.png';
  r := measurement_asset_register(s(11), st('2'), 'op-img-00001', loc('b'), 1, 20, 10, '00000000000000aa', p, '{"x":0}', 100, 200, 10);
  ASSERT r->>'status'='ready' AND r->>'location_id'=loc('b')::text, 'registered at B';
  r := measurement_asset_register(s(11), st('2'), 'op-img-00001', loc('b'), 1, 20, 10, '00000000000000aa', p, '{"x":0}', 100, 200, 10);
  ASSERT (r->>'replayed')::boolean, 'replay';
  PERFORM test_expect_err(format('select measurement_asset_register(%L,%L,%L,%L,1,20,10,%L,%L,''{}'',100,200,10)', s(11), st('2'), 'op-img-00001', loc('b'), '00000000000000bb', p2), 'op_conflict');
  PERFORM test_expect_err(format('select measurement_asset_register(%L,%L,%L,%L,1,20,10,%L,%L,''{}'',100,200,10)', s(11), st('2'), 'op-img-00002', loc('b'), '00000000000000bb', p2), 'image_conflict');
  PERFORM test_expect_err(format('select measurement_asset_register(%L,%L,%L,%L,1,20,10,%L,%L,''{}'',100,200,10)', s(11), st('1'), 'op-img-00003', loc('a'), '00000000000000bb', p2), 'location_mismatch');
  PERFORM test_expect_err(format('select measurement_asset_register(%L,%L,%L,%L,1,20,10,%L,%L,''{}'',100,200,10)', s(11), st('9'), 'op-img-00004', loc('a'), '00000000000000bb', p2), 'location_mismatch');
  PERFORM test_expect_err(format('select measurement_asset_register(%L,%L,%L,%L,1,20,10,%L,%L,''{}'',100,200,10)', s(11), st('1'), 'op-img-00005', loc('b'), '00000000000000bb', p2), 'unauthorized_role');
  PERFORM test_expect_err(format('select measurement_asset_register(%L,%L,%L,%L,1,21,10,%L,%L,''{}'',100,200,10)', s(11), st('2'), 'op-img-00006', loc('b'), '00000000000000bb', p2), 'revision_conflict');
  ASSERT (SELECT cutout_preview_path FROM product_measurement_assets WHERE sku_id=s(11) AND revision=1)=p, 'first write wins';
  RAISE NOTICE 'PASS asset register stock/permission/idempotency';
END $$;

-- 12 跨店隐私：调拨后旧店看不到提醒/任务
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM inv_handheld_notifications n JOIN product_measurement_tasks t ON t.id=n.ref_id
                     WHERE t.sku_id IN (s(1),s(5),s(6)) AND n.location_id=loc('a')), 'old store sees nothing';
  ASSERT NOT EXISTS (SELECT 1 FROM product_measurement_tasks WHERE sku_id IN (s(5),s(6)) AND location_id=loc('a')), 'no task at A';
  RAISE NOTICE 'PASS cross-store privacy after transfer';
END $$;

-- 13 权限：新函数对 anon/authenticated 不可执行
DO $$ BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.measurement_request(uuid,uuid)', 'EXECUTE'), 'auth no exec request';
  ASSERT NOT has_function_privilege('anon', 'public.measurement_task_rebalance(uuid)', 'EXECUTE'), 'anon no exec rebalance';
  ASSERT has_function_privilege('service_role', 'public.measurement_save(uuid,uuid,uuid,text,integer,uuid,numeric,numeric,numeric,numeric)', 'EXECUTE'), 'service exec save';
  RAISE NOTICE 'PASS grants service_role only';
END $$;

-- 14 领取：调拨 A→B 后旧 A 员工拒绝（不泄露新店），B 员工可领；同 actor 幂等也重验；HQ 无货不可绕过
DO $$ DECLARE r jsonb; t uuid; BEGIN
  PERFORM test_mk(14,'a','a=1,b=0');
  t := (measurement_request(l(14), cu(1))->>'task_id')::uuid;
  r := measurement_claim(t, st('1'));
  ASSERT r->>'status'='claimed' AND NOT (r->>'replayed')::boolean, 'A claims at A';
  r := measurement_claim(t, st('1'));
  ASSERT (r->>'replayed')::boolean, 'same actor idempotent';
  ASSERT NOT (r ? 'location_id'), 'no store info in result';
  PERFORM test_expect_err(format('select measurement_claim(%L,%L)', t, st('2')), 'forbidden');
END $$;
UPDATE inv_stocks SET qty=0 WHERE sku_id=s(14) AND location_id=loc('a');
UPDATE inv_stocks SET qty=1 WHERE sku_id=s(14) AND location_id=loc('b');
DO $$ DECLARE r jsonb; t uuid; BEGIN
  SELECT id INTO t FROM product_measurement_tasks WHERE sku_id=s(14) AND status IN ('pending','claimed');
  ASSERT (SELECT location_id FROM product_measurement_tasks WHERE id=t)=loc('b'), 'moved to B, claim cleared';
  -- 旧 A 员工（包括曾领取者）重试：forbidden，错误不含门店 id
  BEGIN PERFORM measurement_claim(t, st('1')); RAISE EXCEPTION 'FAIL old A claimed';
  EXCEPTION WHEN OTHERS THEN
    ASSERT SQLERRM = 'forbidden', 'old A forbidden without store info: ' || SQLERRM;
  END;
  ASSERT (SELECT claimed_by FROM product_measurement_tasks WHERE id=t) IS NULL, 'not claimed by A';
  r := measurement_claim(t, st('2'));
  ASSERT r->>'status'='claimed' AND (SELECT claimed_by FROM product_measurement_tasks WHERE id=t)=st('2'), 'B claims';
  PERFORM test_expect_err(format('select measurement_claim(%L,%L)', t, st('9')), 'already_claimed');
  RAISE NOTICE 'PASS claim after transfer: old store rejected, new store claims';
END $$;
UPDATE inv_stocks SET qty=0 WHERE sku_id=s(14);
DO $$ DECLARE t uuid; BEGIN
  SELECT id INTO t FROM product_measurement_tasks WHERE sku_id=s(14) AND status='pending';
  PERFORM test_expect_err(format('select measurement_claim(%L,%L)', t, st('9')), 'no_stock');
  PERFORM test_expect_err(format('select measurement_claim(%L,%L)', t, st('2')), 'no_stock');
  PERFORM test_expect_err(format('select measurement_claim(%L,%L)', gen_random_uuid(), st('9')), 'not_found');
  UPDATE product_measurement_tasks SET location_id=NULL WHERE id=t;
  PERFORM test_expect_err(format('select measurement_claim(%L,%L)', t, st('9')), 'forbidden');
  ASSERT NOT has_function_privilege('authenticated','public.measurement_claim(uuid,uuid)','EXECUTE'), 'claim service only';
  RAISE NOTICE 'PASS claim no-stock/NULL store not bypassable by HQ';
END $$;
