\set ON_ERROR_STOP 1
-- 可靠性反例（独立审计 3 项红测 + 完整性/缺货/真实拣货后登记/乱序重放/manual 承运商）。
-- 履约：g1 两行(各1件)已拣满 status=picked；g2 一行未拣；g3 两行，只拣一行；g4 缺货待客户确认；g5 缺货已同意退款完成；g6 缺货退款中。
INSERT INTO inv_locations(id) VALUES ('00000000-0000-0000-0000-00000000001a') ON CONFLICT DO NOTHING;
INSERT INTO user_roles VALUES ('00000000-0000-0000-0000-0000000001e2','hq_operator');
INSERT INTO commerce_orders VALUES
 ('00000000-0000-0000-0000-0000000001a1','paid','processing','shipping'),('00000000-0000-0000-0000-0000000001a2','paid','processing','shipping'),
 ('00000000-0000-0000-0000-0000000001a3','paid','processing','shipping'),('00000000-0000-0000-0000-0000000001a4','paid','processing','shipping'),
 ('00000000-0000-0000-0000-0000000001a5','paid','processing','shipping'),('00000000-0000-0000-0000-0000000001a6','paid','processing','shipping'),
 ('00000000-0000-0000-0000-0000000001a7','paid','processing','shipping');
INSERT INTO fulfillments(id,order_id,location_id,status) VALUES
 ('00000000-0000-0000-0000-0000000001f1','00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-00000000001a','picked'),
 ('00000000-0000-0000-0000-0000000001f2','00000000-0000-0000-0000-0000000001a2','00000000-0000-0000-0000-00000000001a','allocated'),
 ('00000000-0000-0000-0000-0000000001f3','00000000-0000-0000-0000-0000000001a3','00000000-0000-0000-0000-00000000001a','picking'),
 ('00000000-0000-0000-0000-0000000001f4','00000000-0000-0000-0000-0000000001a4','00000000-0000-0000-0000-00000000001a','picking'),
 ('00000000-0000-0000-0000-0000000001f5','00000000-0000-0000-0000-0000000001a5','00000000-0000-0000-0000-00000000001a','picking'),
 ('00000000-0000-0000-0000-0000000001f6','00000000-0000-0000-0000-0000000001a6','00000000-0000-0000-0000-00000000001a','picking'),
 ('00000000-0000-0000-0000-0000000001f7','00000000-0000-0000-0000-0000000001a7','00000000-0000-0000-0000-00000000001a','picked');
INSERT INTO fulfillment_items(id,fulfillment_id,expected_qty,picked_qty) VALUES
 ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-0000000001f1',1,1),('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-0000000001f1',1,1),
 ('00000000-0000-0000-0000-000000000121','00000000-0000-0000-0000-0000000001f2',2,0),
 ('00000000-0000-0000-0000-000000000131','00000000-0000-0000-0000-0000000001f3',1,0),('00000000-0000-0000-0000-000000000132','00000000-0000-0000-0000-0000000001f3',1,0),
 ('00000000-0000-0000-0000-000000000141','00000000-0000-0000-0000-0000000001f4',2,1),
 ('00000000-0000-0000-0000-000000000151','00000000-0000-0000-0000-0000000001f5',2,1),
 ('00000000-0000-0000-0000-000000000161','00000000-0000-0000-0000-0000000001f6',2,1),
 ('00000000-0000-0000-0000-000000000171','00000000-0000-0000-0000-0000000001f7',1,1);
INSERT INTO fulfillment_shortages(fulfillment_id,fulfillment_item_id,quantity,status,refund_state) VALUES
 ('00000000-0000-0000-0000-0000000001f4','00000000-0000-0000-0000-000000000141',1,'pending_customer','awaiting_confirmation'),
 ('00000000-0000-0000-0000-0000000001f5','00000000-0000-0000-0000-000000000151',1,'customer_accepted','refund_completed'),
 ('00000000-0000-0000-0000-0000000001f6','00000000-0000-0000-0000-000000000161',1,'customer_accepted','refund_pending');
SET ROLE service_role;
-- 红测 1：有效行 + 不存在行 → 必须整体失败、首行 picked_qty 不变
DO $$ DECLARE r jsonb; n int; hq uuid:='00000000-0000-0000-0000-0000000001e2'; BEGIN
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f2','sf','SFT001',
     '[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000121","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-0000000009ff","quantity":1}]','red1-partial');
  SELECT picked_qty INTO n FROM fulfillment_items WHERE id='00000000-0000-0000-0000-000000000121';
  ASSERT r->>'ok'='false' AND n=0, format('partial write: result=%s picked=%s', r, n);
  SELECT count(*) INTO n FROM shipments WHERE fulfillment_id='00000000-0000-0000-0000-0000000001f2'; ASSERT n=0, 'no shipment';
  RAISE NOTICE 'PASS red1 invalid line rolls back everything';
END $$;
-- 红测 3：已拣满 picked → 登记发货必须成功，且不重复增加 picked_qty
DO $$ DECLARE r jsonb; n int; hq uuid:='00000000-0000-0000-0000-0000000001e2'; BEGIN
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f7','sf','SFTEST02',
     '[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000171","quantity":1}]','replay-test');
  ASSERT r->>'result'='shipped', 'picked-full ship: '||r::text;
  SELECT picked_qty INTO n FROM fulfillment_items WHERE id='00000000-0000-0000-0000-000000000171'; ASSERT n=1, 'picked not doubled';
  RAISE NOTICE 'PASS red3 ship after real pick';
END $$;
-- 红测 2：同 key + 同承运商单号但 qty 不同 → 必须冲突
DO $$ DECLARE r jsonb; hq uuid:='00000000-0000-0000-0000-0000000001e2'; BEGIN
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f7','sf','SFTEST02',
     '[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000171","quantity":2}]','replay-test');
  ASSERT r->>'result'='idempotency_conflict', 'replay with different qty: '||r::text;
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f7','sf','SFTEST02',
     '[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000171","quantity":1}]','replay-test');
  ASSERT r->>'result'='shipped' AND (r->>'replayed')::bool, 'same content replays: '||r::text;
  RAISE NOTICE 'PASS red2 replay content-checked';
END $$;
