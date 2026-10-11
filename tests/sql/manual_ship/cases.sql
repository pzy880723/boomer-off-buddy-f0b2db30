\set ON_ERROR_STOP 1
-- 门店 A/B；员工 sa 仅 A；hq 总部；o1 已付快递，o2 自提，o3 未付，o4 退款中，o5 售后
INSERT INTO inv_locations(id) VALUES ('00000000-0000-0000-0000-00000000000a'),('00000000-0000-0000-0000-00000000000b');
INSERT INTO user_roles VALUES ('00000000-0000-0000-0000-0000000000e1','store_staff'),('00000000-0000-0000-0000-0000000000e2','hq_operator'),('00000000-0000-0000-0000-0000000000e3','store_staff');
INSERT INTO user_location_perms VALUES ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000000a');
INSERT INTO commerce_orders VALUES
 ('00000000-0000-0000-0000-0000000000a1','paid','processing','shipping'),
 ('00000000-0000-0000-0000-0000000000a2','paid','processing','pickup'),
 ('00000000-0000-0000-0000-0000000000a3','unpaid','pending_payment','shipping'),
 ('00000000-0000-0000-0000-0000000000a4','refund_pending','after_sale','shipping'),
 ('00000000-0000-0000-0000-0000000000a5','paid','after_sale','shipping'),
 ('00000000-0000-0000-0000-0000000000a6','paid','processing','shipping');
INSERT INTO fulfillments(id,order_id,location_id,status) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','picked'),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000000a','picked'),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000000a','allocated'),
 ('00000000-0000-0000-0000-0000000000f4','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-00000000000a','picked'),
 ('00000000-0000-0000-0000-0000000000f5','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-00000000000a','picked'),
 ('00000000-0000-0000-0000-0000000000f6','00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-00000000000b','picked');
INSERT INTO fulfillment_items(id,fulfillment_id,expected_qty) VALUES
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1',1),
 ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000f2',1),
 ('00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-0000000000f3',1),
 ('00000000-0000-0000-0000-0000000000b4','00000000-0000-0000-0000-0000000000f4',1),
 ('00000000-0000-0000-0000-0000000000b5','00000000-0000-0000-0000-0000000000f5',1),
 ('00000000-0000-0000-0000-0000000000b6','00000000-0000-0000-0000-0000000000f6',1);
SET ROLE service_role;
DO $$ DECLARE r jsonb; sa uuid:='00000000-0000-0000-0000-0000000000e1'; hq uuid:='00000000-0000-0000-0000-0000000000e2'; nobody uuid:='00000000-0000-0000-0000-0000000000e3';
  A uuid:='00000000-0000-0000-0000-00000000000a'; B uuid:='00000000-0000-0000-0000-00000000000b';
  ln jsonb; n int;
BEGIN
  ln := '[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]';
  r := commerce_manual_ship_fulfillment(nobody, NULL, '00000000-0000-0000-0000-0000000000f1','sf','SF0001',ln,'op-nobody-1'); ASSERT r->>'result'='forbidden', 'no perm '||r::text;
  r := commerce_manual_ship_fulfillment(sa, B, '00000000-0000-0000-0000-0000000000f1','sf','SF0001',ln,'op-wrongloc'); ASSERT r->>'result'='location_forbidden', 'device loc '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','ems','SF0001',ln,'op-badprov'); ASSERT r->>'result'='invalid_provider', 'provider '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','sf','SF0001','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b1","quantity":2}]','op-qty'); ASSERT r->>'result'='qty_exceeded', 'qty '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','sf','SF0001','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b2","quantity":1}]','op-foreign'); ASSERT r->>'result'='invalid_lines', 'foreign line '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','sf','SF0001',ln,'op-ship-1'); ASSERT r->>'result'='shipped' AND NOT (r->>'replayed')::bool, 'ship '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','sf','SF0001',ln,'op-ship-1'); ASSERT r->>'result'='shipped' AND (r->>'replayed')::bool, 'replay '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','sf','SF9999',ln,'op-ship-1'); ASSERT r->>'result'='idempotency_conflict', 'conflict '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f1','sf','SF0002',ln,'op-ship-2'); ASSERT r->>'result'='already_shipped', 'dup '||r::text;
  SELECT picked_qty INTO n FROM fulfillment_items WHERE id='00000000-0000-0000-0000-0000000000b1'; ASSERT n=1, 'picked once';
  SELECT count(*) INTO n FROM fulfillments WHERE id='00000000-0000-0000-0000-0000000000f1' AND status='handed_over'; ASSERT n=1, 'handed over';
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f2','sf','SF0003','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b2","quantity":1}]','op-pickup'); ASSERT r->>'result'='pickup_order', 'pickup '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f3','sf','SF0004','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b3","quantity":1}]','op-unpaid'); ASSERT r->>'result'='unpaid', 'unpaid '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f4','sf','SF0005','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b4","quantity":1}]','op-refund'); ASSERT r->>'result'='refund_blocked', 'refund '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, '00000000-0000-0000-0000-0000000000f5','sf','SF0006','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b5","quantity":1}]','op-after'); ASSERT r->>'result'='after_sale_blocked', 'after sale '||r::text;
  r := commerce_manual_ship_fulfillment(sa, NULL, '00000000-0000-0000-0000-0000000000f6','sf','SF0007','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b6","quantity":1}]','op-crossstore'); ASSERT r->>'result'='forbidden', 'cross store '||r::text;
  r := commerce_manual_ship_fulfillment(hq, NULL, '00000000-0000-0000-0000-0000000000f6','cainiao','CN0007','[{"fulfillment_item_id":"00000000-0000-0000-0000-0000000000b6","quantity":1}]','op-hq-01'); ASSERT r->>'result'='shipped', 'hq '||r::text;
  r := commerce_manual_ship_fulfillment(sa, A, gen_random_uuid(),'sf','SF0008',ln,'op-missing'); ASSERT r->>'result'='not_found', 'missing '||r::text;
  SELECT count(*) INTO n FROM shipments; ASSERT n=2, 'only 2 shipments '||n;
  RAISE NOTICE 'PASS behavior';
END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN PERFORM commerce_manual_ship_fulfillment(gen_random_uuid(),NULL,gen_random_uuid(),'sf','SF0001','[]','op-12345678'); RAISE EXCEPTION 'auth rpc'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS authenticated rpc denied'; END $$;
RESET ROLE;
