\set ON_ERROR_STOP 1
INSERT INTO inv_locations VALUES ('00000000-0000-0000-0000-00000000000a','A店'),('00000000-0000-0000-0000-00000000000b','B店');
-- o1 跨店（A+B），o2 单店A含赠礼行，o3 未付款后取消，o4 POS，o5 付款后退款
INSERT INTO commerce_orders(id,order_no,metadata,customer_phone,shipping_address,source_channel) VALUES
 ('00000000-0000-0000-0000-0000000000a1','N1','{"sales_origin":{"version":1,"platform":"miniapp"}}','13800138000','{"addr":"x路1号"}','storefront'),
 ('00000000-0000-0000-0000-0000000000a2','N2','{"sales_origin":{"version":1,"platform":"app"}}',null,null,'storefront'),
 ('00000000-0000-0000-0000-0000000000a3','N3','{}',null,null,'storefront'),
 ('00000000-0000-0000-0000-0000000000a4','N4','{}',null,null,'pos'),
 ('00000000-0000-0000-0000-0000000000a5','N5','{"sales_origin":{"platform":"evil"}}',null,null,'storefront');
INSERT INTO fulfillments(id,code,order_id,location_id) VALUES
 ('00000000-0000-0000-0000-0000000000f1','F1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-0000000000f2','F2','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000b'),
 ('00000000-0000-0000-0000-0000000000f3','F3','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-0000000000f4','F4','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-0000000000f5','F5','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-00000000000a');
INSERT INTO commerce_order_items(order_id,location_id,is_gift) VALUES
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000000a',false),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000000a',true);

DO $$ DECLARE n int; p jsonb; BEGIN
  -- 未付款：不得有提醒
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE kind='order_paid'; ASSERT n=0, 'unpaid has none';
  -- 跨店付款 → 每店一条
  UPDATE commerce_orders SET payment_status='paid', order_status='confirmed', paid_at=now() WHERE id='00000000-0000-0000-0000-0000000000a1';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE kind='order_paid' AND payload->>'order_id'='00000000-0000-0000-0000-0000000000a1';
  ASSERT n=2, format('cross-store expect 2 got %s', n);
  SELECT count(DISTINCT location_id) INTO n FROM inv_handheld_notifications WHERE kind='order_paid'; ASSERT n=2, 'one per store';
  -- 重复回调/重放：再次置 paid 不重复
  UPDATE commerce_orders SET payment_status='paid' WHERE id='00000000-0000-0000-0000-0000000000a1';
  UPDATE commerce_orders SET payment_status='unpaid' WHERE id='00000000-0000-0000-0000-0000000000a1';
  UPDATE commerce_orders SET payment_status='paid' WHERE id='00000000-0000-0000-0000-0000000000a1';
  PERFORM handheld_notify_order_paid('00000000-0000-0000-0000-0000000000a1');
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE kind='order_paid'; ASSERT n=2, format('replay dedupe got %s', n);
  -- 时间戳互不相同（游标不跳行）
  SELECT count(DISTINCT ts) INTO n FROM inv_handheld_notifications WHERE kind='order_paid'; ASSERT n=2, 'distinct ts';
  -- 负载：来源、关联、无敏感明文
  SELECT payload INTO p FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f1';
  ASSERT p->>'sales_origin'='miniapp' AND p->>'fulfillment_id'='00000000-0000-0000-0000-0000000000f1' AND p->>'order_no'='N1', 'payload';
  ASSERT p::text NOT LIKE '%13800138000%' AND p::text NOT LIKE '%x路1号%', 'no pii';
  -- 单店含赠礼行 → 只 1 条
  UPDATE commerce_orders SET payment_status='paid', order_status='confirmed', paid_at=now() WHERE id='00000000-0000-0000-0000-0000000000a2';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE payload->>'order_id'='00000000-0000-0000-0000-0000000000a2'; ASSERT n=1, 'gift no extra';
  SELECT payload INTO p FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f3'; ASSERT p->>'sales_origin'='app', 'app origin';
  -- 未付款取消 → 无提醒
  UPDATE commerce_orders SET order_status='cancelled' WHERE id='00000000-0000-0000-0000-0000000000a3';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE payload->>'order_id'='00000000-0000-0000-0000-0000000000a3'; ASSERT n=0, 'cancel unpaid none';
  -- POS 付款 → 无提醒
  UPDATE commerce_orders SET payment_status='paid', order_status='completed', paid_at=now() WHERE id='00000000-0000-0000-0000-0000000000a4';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE payload->>'order_id'='00000000-0000-0000-0000-0000000000a4'; ASSERT n=0, 'pos none';
  -- 付款后才建履约（先付后分配）→ 补发；来源非法记 unknown
  UPDATE commerce_orders SET payment_status='paid', order_status='confirmed', paid_at=now() WHERE id='00000000-0000-0000-0000-0000000000a5';
  INSERT INTO fulfillments(id,code,order_id,location_id) VALUES ('00000000-0000-0000-0000-0000000000f6','F6','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-00000000000b');
  SELECT payload INTO p FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f6';
  ASSERT p->>'sales_origin'='unknown', 'late fulfillment + unknown origin';
  -- 付款后退款 → 原提醒标记 voided，不删除
  UPDATE commerce_orders SET payment_status='refunded', order_status='closed' WHERE id='00000000-0000-0000-0000-0000000000a5';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f6' AND action_status='voided'; ASSERT n=1, 'refund voided';
  -- 已退款订单再插履约不补发
  INSERT INTO fulfillments(id,code,order_id,location_id) VALUES ('00000000-0000-0000-0000-0000000000f7','F7','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-00000000000a');
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f7'; ASSERT n=0, 'refunded none';
  -- 员工开始拣货 → handled
  UPDATE fulfillments SET status='picking' WHERE id='00000000-0000-0000-0000-0000000000f1';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f1' AND action_status='handled'; ASSERT n=1, 'handled';
  SELECT count(*) INTO n FROM inv_handheld_notifications WHERE ref_id='00000000-0000-0000-0000-0000000000f2' AND action_status IS NULL; ASSERT n=1, 'other store untouched';
  RAISE NOTICE 'PASS behavior';
END $$;
SET ROLE anon;
DO $$ BEGIN PERFORM handheld_notify_order_paid(gen_random_uuid()); RAISE EXCEPTION 'anon rpc'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS anon rpc denied'; END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN PERFORM handheld_notify_order_paid(gen_random_uuid()); RAISE EXCEPTION 'auth rpc'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS authenticated rpc denied'; END $$;
RESET ROLE;
