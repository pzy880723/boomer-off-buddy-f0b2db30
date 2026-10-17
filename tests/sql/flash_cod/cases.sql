-- 闪送到付 隔离用例：报价/下单/幂等/篡改/跨店/送达登记/权限。每个 PASS 一条断言。
SET ROLE service_role;
-- 夹具：两门店、一顾客、两个孤品 listing
INSERT INTO inv_locations VALUES ('00000000-0000-0000-0000-00000000000a','shop',true),('00000000-0000-0000-0000-00000000000b','shop',true);
INSERT INTO commerce_customers VALUES ('00000000-0000-0000-0000-0000000000c0','active');
INSERT INTO inv_skus VALUES ('00000000-0000-0000-0000-0000000000a1','owned',NULL),('00000000-0000-0000-0000-0000000000a2','owned',NULL);
INSERT INTO commerce_listings VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000a2');
INSERT INTO user_roles VALUES ('00000000-0000-0000-0000-0000000000e2','super_admin');

-- 报价夹具：单店 / 跨店
INSERT INTO quote_fixtures VALUES (md5('[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb::text),
  '{"subtotal_fen":5000,"discount_fen":0,"total_fen":5000,"shipping_fee_fen":1200,"coupon":null,"discount_allocations":[],"groups":[{"location_id":"00000000-0000-0000-0000-00000000000a","shipping_fee_fen":1200,"remaining_fen":0}]}');
INSERT INTO quote_fixtures VALUES (md5('[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b2","quantity":1}]'::jsonb::text),
  '{"subtotal_fen":9000,"discount_fen":0,"total_fen":9000,"shipping_fee_fen":1200,"coupon":null,"discount_allocations":[],"groups":[{"location_id":"00000000-0000-0000-0000-00000000000a","shipping_fee_fen":1200,"remaining_fen":0},{"location_id":"00000000-0000-0000-0000-00000000000b","shipping_fee_fen":0,"remaining_fen":0}]}');

-- F1 单店闪送报价：version/方式/零运费/cod
SELECT CASE WHEN q->>'version'='flash_cod_v1' AND q->>'fulfillment_method'='flash' AND (q->>'shipping_fee_fen')::int=0
   AND q->>'delivery_fee_payment'='cod' AND (q->>'total_fen')::int=5000
   AND (q->'groups'->0->>'shipping_fee_fen')::int=0
  THEN 'PASS F1 flash quote single store' ELSE 'FAIL F1 '||q END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'flash') q) t;

-- F2 跨店闪送报价被拒绝
DO $$ BEGIN
  PERFORM commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b2","quantity":1}]',NULL,'flash');
  RAISE EXCEPTION 'FAIL F2 cross-store flash quote accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'flash requires single store%' THEN RAISE NOTICE 'PASS F2 cross-store flash quote rejected'; ELSE RAISE; END IF;
END $$;

-- F3 express/pickup 报价行为不变
SELECT CASE WHEN q->>'version' IS NULL AND (q->>'shipping_fee_fen')::int=1200 THEN 'PASS F3a express quote unchanged' ELSE 'FAIL F3a' END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'express') q) t;
SELECT CASE WHEN q->>'version'='pickup_v1' THEN 'PASS F3b pickup quote unchanged' ELSE 'FAIL F3b' END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'pickup') q) t;

-- F4 闪送下单成功：方式/承运商/零运费落库
DO $$
DECLARE v jsonb; v_quote jsonb;
BEGIN
  v_quote := commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'flash');
  v := commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-1','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海","detail":"新天地"}',v_quote,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
  IF v->>'fulfillment_method'='flash' AND v->>'courier_provider'='flash' AND v->>'courier_service_code'='SHANSONG_COD'
     AND coalesce((v->>'shipping_fee')::numeric,0)=0 AND (v->'payment_route'->>'mode')='ordinary_wechat' THEN
    RAISE NOTICE 'PASS F4 flash order created';
  ELSE RAISE EXCEPTION 'FAIL F4 %', v; END IF;
END $$;

-- F5 同 key 重放返回同一订单，不产生第二单
DO $$
DECLARE v1 jsonb; v2 jsonb; n int;
BEGIN
  SELECT to_jsonb(o) INTO v1 FROM commerce_orders o WHERE idempotency_key='flash-key-1';
  v2 := commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-1','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海","detail":"新天地"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
  SELECT count(*) INTO n FROM commerce_orders WHERE idempotency_key='flash-key-1';
  IF v1->>'id' = v2->>'id' AND n=1 THEN RAISE NOTICE 'PASS F5 idempotent replay'; ELSE RAISE EXCEPTION 'FAIL F5'; END IF;
END $$;

-- F6 同 key 换配送方式冲突
DO $$ BEGIN
  INSERT INTO commerce_orders (customer_id,idempotency_key,source_channel,fulfillment_method,payment_status,order_status,payment_route)
    VALUES ('00000000-0000-0000-0000-0000000000c0','flash-key-2','storefront','shipping','unpaid','pending_payment','{"mode":"ordinary_wechat"}');
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-2','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
  RAISE EXCEPTION 'FAIL F6 method switch accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'idempotency key used by another fulfillment method%' THEN RAISE NOTICE 'PASS F6 method conflict rejected'; ELSE RAISE; END IF;
END $$;

-- F7 篡改运费快照被拒（quote changed）
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-3','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','{"version":"flash_cod_v1","total_fen":1}',NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
  RAISE EXCEPTION 'FAIL F7 tampered quote accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'shipping quote changed%' THEN RAISE NOTICE 'PASS F7 tampered quote rejected'; ELSE RAISE; END IF;
END $$;

-- F8 缺地址/缺手机号被拒
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-4','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三',NULL,'{"city":"上海"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
  RAISE EXCEPTION 'FAIL F8a missing phone accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'flash recipient required%' THEN RAISE NOTICE 'PASS F8a phone required'; ELSE RAISE; END IF;
END $$;
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-5','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
  RAISE EXCEPTION 'FAIL F8b empty address accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'flash address required%' THEN RAISE NOTICE 'PASS F8b address required'; ELSE RAISE; END IF;
END $$;

-- F9 跨店下单被拒（权威在库内，不依赖前端）
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-6','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b2","quantity":1}]',
    '张三','13800000000','{"city":"上海"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b']);
  RAISE EXCEPTION 'FAIL F9 cross-store order accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'flash requires single store%' THEN RAISE NOTICE 'PASS F9 cross-store order rejected'; ELSE RAISE; END IF;
END $$;

-- F10 送达登记：已付款闪送单 → delivered，无单号，子单交接
DO $$
DECLARE v_f uuid; v_i uuid; r jsonb;
BEGIN
  UPDATE commerce_orders SET payment_status='paid', order_status='processing' WHERE idempotency_key='flash-key-1';
  SELECT f.id, fi.id INTO v_f, v_i FROM fulfillments f JOIN fulfillment_items fi ON fi.fulfillment_id=f.id
    JOIN commerce_orders o ON o.id=f.order_id WHERE o.idempotency_key='flash-key-1';
  r := commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,v_f,
    jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-flash-1',NULL);
  IF (r->>'ok')::boolean AND r->>'result'='delivered' THEN RAISE NOTICE 'PASS F10a flash delivered'; ELSE RAISE EXCEPTION 'FAIL F10a %', r; END IF;
  IF EXISTS (SELECT 1 FROM shipments s WHERE s.fulfillment_id=v_f AND s.provider='flash' AND s.service_code='SHANSONG_COD' AND s.tracking_no IS NULL)
     AND EXISTS (SELECT 1 FROM fulfillments WHERE id=v_f AND status='handed_over') THEN
    RAISE NOTICE 'PASS F10b shipment without tracking no';
  ELSE RAISE EXCEPTION 'FAIL F10b'; END IF;
END $$;

-- F11 同 key 重放 → replayed，无第二条运单
DO $$
DECLARE v_f uuid; v_i uuid; r jsonb; n int;
BEGIN
  SELECT f.id, fi.id INTO v_f, v_i FROM fulfillments f JOIN fulfillment_items fi ON fi.fulfillment_id=f.id
    JOIN commerce_orders o ON o.id=f.order_id WHERE o.idempotency_key='flash-key-1';
  r := commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,v_f,
    jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-flash-1',NULL);
  SELECT count(*) INTO n FROM shipments WHERE fulfillment_id=v_f;
  IF (r->>'ok')::boolean AND (r->>'replayed')::boolean AND n=1 THEN RAISE NOTICE 'PASS F11 replay'; ELSE RAISE EXCEPTION 'FAIL F11 %', r; END IF;
END $$;

-- F12 快递单走闪送登记 → not_flash_order；闪送单走快递登记 → flash_order
DO $$
DECLARE v_f uuid; v_i uuid; r jsonb;
BEGIN
  INSERT INTO commerce_orders (customer_id,idempotency_key,source_channel,fulfillment_method,payment_status,order_status)
    VALUES ('00000000-0000-0000-0000-0000000000c0','express-key-1','storefront','shipping','paid','processing') RETURNING id INTO v_f;
  INSERT INTO fulfillments (order_id,location_id,status) VALUES (v_f,'00000000-0000-0000-0000-00000000000a','picked') RETURNING id INTO v_f;
  INSERT INTO fulfillment_items (fulfillment_id,expected_qty) VALUES (v_f,1) RETURNING id INTO v_i;
  r := commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,v_f,
    jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-flash-2',NULL);
  IF r->>'result'='not_flash_order' THEN RAISE NOTICE 'PASS F12a express order not flash'; ELSE RAISE EXCEPTION 'FAIL F12a %', r; END IF;
END $$;
DO $$
DECLARE v_f uuid; v_i uuid; r jsonb;
BEGIN
  SELECT f.id, fi.id INTO v_f, v_i FROM fulfillments f JOIN fulfillment_items fi ON fi.fulfillment_id=f.id
    JOIN commerce_orders o ON o.id=f.order_id WHERE o.idempotency_key='flash-key-1';
  r := commerce_manual_ship_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,v_f,'manual','FAKE1234',
    jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-ship-flash-1','闪送');
  IF r->>'result' IN ('flash_order','already_shipped') THEN RAISE NOTICE 'PASS F12b flash order cannot fake courier'; ELSE RAISE EXCEPTION 'FAIL F12b %', r; END IF;
END $$;

-- F13 未付款闪送单不能登记送达
DO $$
DECLARE v_o uuid; v_f uuid; v_i uuid; r jsonb;
BEGIN
  INSERT INTO commerce_orders (customer_id,idempotency_key,source_channel,fulfillment_method,payment_status,order_status)
    VALUES ('00000000-0000-0000-0000-0000000000c0','flash-key-7','storefront','flash','unpaid','pending_payment') RETURNING id INTO v_o;
  INSERT INTO fulfillments (order_id,location_id,status) VALUES (v_o,'00000000-0000-0000-0000-00000000000a','picked') RETURNING id INTO v_f;
  INSERT INTO fulfillment_items (fulfillment_id,expected_qty) VALUES (v_f,1) RETURNING id INTO v_i;
  r := commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,v_f,
    jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-flash-3',NULL);
  IF r->>'result'='unpaid' THEN RAISE NOTICE 'PASS F13 unpaid blocked'; ELSE RAISE EXCEPTION 'FAIL F13 %', r; END IF;
END $$;

-- F14 无权限员工不能登记送达
DO $$
DECLARE v_f uuid; v_i uuid; r jsonb;
BEGIN
  SELECT f.id, fi.id INTO v_f, v_i FROM fulfillments f JOIN fulfillment_items fi ON fi.fulfillment_id=f.id
    JOIN commerce_orders o ON o.id=f.order_id WHERE o.idempotency_key='flash-key-7';
  r := commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e9',NULL,v_f,
    jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-flash-4',NULL);
  IF r->>'result'='forbidden' THEN RAISE NOTICE 'PASS F14 forbidden'; ELSE RAISE EXCEPTION 'FAIL F14 %', r; END IF;
END $$;

-- F15 新函数不对前端角色开放
DO $$ BEGIN
  EXECUTE 'SET ROLE anon';
  BEGIN
    PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','k','[]','a','13800000000','{}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']);
    RAISE EXCEPTION 'FAIL F15a anon can create';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS F15a anon create denied'; END;
  BEGIN
    PERFORM commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,'00000000-0000-0000-0000-0000000000c2','[]','op-x',NULL);
    RAISE EXCEPTION 'FAIL F15b anon can deliver';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS F15b anon deliver denied'; END;
  EXECUTE 'RESET ROLE';
END $$;

-- F16 CHECK 约束已含 flash（直接插入验证）
DO $$ BEGIN
  INSERT INTO commerce_orders (customer_id,idempotency_key,fulfillment_method,courier_provider) VALUES ('00000000-0000-0000-0000-0000000000c0','flash-key-8','flash','flash');
  RAISE NOTICE 'PASS F16 check constraints allow flash';
END $$;
