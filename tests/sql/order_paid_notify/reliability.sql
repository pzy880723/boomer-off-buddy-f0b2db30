\set ON_ERROR_STOP 1
-- 可靠性用例：故障注入恢复、重放防重、补偿、变更游标（handled/voided/已读）、同 ts 分页、自提 ready/redeem。
INSERT INTO inv_locations VALUES ('00000000-0000-0000-0000-00000000000c','C店') ON CONFLICT DO NOTHING;
INSERT INTO commerce_orders(id,order_no,source_channel) VALUES
 ('00000000-0000-0000-0000-0000000000c1','R1','storefront'),
 ('00000000-0000-0000-0000-0000000000c2','R2','storefront');
INSERT INTO fulfillments(id,code,order_id,location_id) VALUES
 ('00000000-0000-0000-0000-0000000000e1','E1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-00000000000c'),
 ('00000000-0000-0000-0000-0000000000e2','E2','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-00000000000c');

-- Codex 精确反例：通知写入故障 → 付款仍成功 → 移除故障 → 重复置 paid 必须补出提醒。
CREATE FUNCTION fail_notif() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='P0001'; END $$;
CREATE TRIGGER zz_fail BEFORE INSERT ON inv_handheld_notifications FOR EACH ROW EXECUTE FUNCTION fail_notif();
UPDATE commerce_orders SET payment_status='paid', order_status='confirmed', paid_at=now()
 WHERE id IN ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2');
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM commerce_orders WHERE order_no IN ('R1','R2') AND payment_status='paid'; ASSERT n=2, 'payment must survive notify failure';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id IN ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2'); ASSERT n=0, 'no alert while failing';
END $$;
DROP TRIGGER zz_fail ON inv_handheld_notifications;
UPDATE commerce_orders SET payment_status='paid' WHERE id='00000000-0000-0000-0000-0000000000c1';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000e1';
  ASSERT n=1, 'paid callback replay did not recover failed order alert';
  RAISE NOTICE 'PASS replay recovers failed alert';
END $$;
-- 无回调重放时，补偿任务恢复 R2；重复补偿不重复写。
DO $$ DECLARE n int; c int; BEGIN
  c := handheld_notify_reconcile(7, 100); ASSERT c=1, format('reconcile expect 1 got %s', c);
  c := handheld_notify_reconcile(7, 100); ASSERT c=0, 'reconcile idempotent';
  UPDATE commerce_orders SET payment_status='paid' WHERE id='00000000-0000-0000-0000-0000000000c2';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000e2'; ASSERT n=1, 'no dup after reconcile+replay';
  -- 补偿不得为退款/取消/POS/未付款订单伪造提醒
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE payload->>'order_no' IN ('N3','N4'); ASSERT n=0, 'reconcile no fake';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f7'; ASSERT n=0, 'reconcile skips refunded';
  RAISE NOTICE 'PASS reconcile recovers + idempotent + no fake';
END $$;

-- 补偿中单单失败重试：故障期间补偿失败（付款不受影响），恢复后下一次补偿成功。
INSERT INTO commerce_orders(id,order_no,source_channel) VALUES ('00000000-0000-0000-0000-0000000000c3','R3','storefront');
INSERT INTO fulfillments(id,code,order_id,location_id) VALUES ('00000000-0000-0000-0000-0000000000e3','E3','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-00000000000c');
CREATE TRIGGER zz_fail BEFORE INSERT ON inv_handheld_notifications FOR EACH ROW EXECUTE FUNCTION fail_notif();
UPDATE commerce_orders SET payment_status='paid', order_status='confirmed', paid_at=now() WHERE id='00000000-0000-0000-0000-0000000000c3';
DO $$ DECLARE c int; BEGIN c := handheld_notify_reconcile(7,100); ASSERT c=0, 'reconcile during fault writes nothing'; END $$;
DROP TRIGGER zz_fail ON inv_handheld_notifications;
DO $$ DECLARE c int; BEGIN c := handheld_notify_reconcile(7,100); ASSERT c=1, 'reconcile retry succeeds';
  RAISE NOTICE 'PASS reconcile retry after failure'; END $$;

-- 变更游标：handled / voided / 已读 都会作为新变更出现；游标后不重复旧状态。
CREATE TEMP TABLE cur(x text, s bigint);
INSERT INTO cur SELECT change_xid, change_seq FROM handheld_notifications_changes(gen_random_uuid(), gen_random_uuid(),
  ARRAY['00000000-0000-0000-0000-00000000000c']::uuid[], '0', 0, 200) ORDER BY change_xid::xid8 DESC, change_seq DESC LIMIT 1;
UPDATE fulfillments SET status='handover_ready' WHERE id='00000000-0000-0000-0000-0000000000e1'; -- 自提备货
UPDATE fulfillments SET status='handed_over' WHERE id='00000000-0000-0000-0000-0000000000e3';    -- 自提核销
UPDATE commerce_orders SET payment_status='refunded', order_status='closed' WHERE id='00000000-0000-0000-0000-0000000000c2';
INSERT INTO handheld_notification_reads(notification_id,user_id)
  SELECT id, '00000000-0000-0000-0000-0000000000d1' FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000e3';
DO $$ DECLARE r record; n int := 0; BEGIN
  FOR r IN SELECT c.* FROM cur, handheld_notifications_changes('00000000-0000-0000-0000-0000000000d1', gen_random_uuid(),
     ARRAY['00000000-0000-0000-0000-00000000000c']::uuid[], cur.x, cur.s, 200) c LOOP
    n := n + 1;
    IF r.ref_id='00000000-0000-0000-0000-0000000000e1' THEN ASSERT r.action_status='handled', 'ready->handled'; END IF;
    IF r.ref_id='00000000-0000-0000-0000-0000000000e3' THEN ASSERT r.action_status='handled', 'redeem->handled'; END IF;
    IF r.ref_id='00000000-0000-0000-0000-0000000000e2' THEN ASSERT r.action_status='voided', 'refund->voided'; END IF;
  END LOOP;
  ASSERT n=3, format('changes after cursor expect 3 (each row once, latest state) got %s', n);
  RAISE NOTICE 'PASS changes deliver handled/voided/read once with latest state';
END $$;
-- 门店无权：不在授权库位、不定向本人/设备 → 读不到
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM handheld_notifications_changes(gen_random_uuid(), gen_random_uuid(), ARRAY['00000000-0000-0000-0000-00000000000b']::uuid[], '0', 0, 200)
   WHERE location_id='00000000-0000-0000-0000-00000000000c';
  ASSERT n=0, 'other store cannot read';
  RAISE NOTICE 'PASS store scope enforced';
END $$;

-- 同 ts 分页边界：5 条同 ts，page=2 走游标必须恰好拿全 5 条且无重复。
INSERT INTO inv_handheld_notifications(location_id,kind,title,ts)
  SELECT '00000000-0000-0000-0000-00000000000a','system','same-ts','2026-01-01T00:00:00Z' FROM generate_series(1,5);
DO $$ DECLARE x text := '0'; s bigint := 0; got int := 0; r record; loops int := 0; BEGIN
  LOOP
    loops := loops + 1; EXIT WHEN loops > 50;
    PERFORM 1 FROM handheld_notifications_changes(gen_random_uuid(), gen_random_uuid(), ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[], x, s, 2);
    EXIT WHEN NOT FOUND;
    FOR r IN SELECT * FROM handheld_notifications_changes(gen_random_uuid(), gen_random_uuid(), ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[], x, s, 2) LOOP
      IF r.title='same-ts' THEN got := got + 1; END IF; x := r.change_xid; s := r.change_seq;
    END LOOP;
  END LOOP;
  ASSERT got=5, format('same-ts paging expect 5 got %s', got);
  RAISE NOTICE 'PASS same-ts page boundary';
END $$;

SET ROLE anon;
DO $$ BEGIN PERFORM handheld_notify_reconcile(7,1); RAISE EXCEPTION 'anon'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM * FROM handheld_notifications_changes(null,null,null,'0',0,1); RAISE EXCEPTION 'anon'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS anon denied new rpcs'; END $$;
RESET ROLE;
