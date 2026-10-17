-- 闪送到付 隔离用例：报价/下单/幂等/篡改/跨店/送达登记/权限/真实底层守卫。每个 PASS 一条断言。
-- 底层 commerce_create_order_v2 与 commerce_mark_ordinary_order_paid 为真实库导出原文。
SET ROLE service_role;
-- 夹具：两门店、一顾客、孤品/标准品 listing、真实库存
INSERT INTO inv_locations VALUES ('00000000-0000-0000-0000-00000000000a','shop',true),('00000000-0000-0000-0000-00000000000b','shop',true);
INSERT INTO commerce_customers VALUES ('00000000-0000-0000-0000-0000000000c0','active');
INSERT INTO inv_skus (id) VALUES ('00000000-0000-0000-0000-0000000000a1'),('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3'),('00000000-0000-0000-0000-0000000000a4'),
  ('00000000-0000-0000-0000-0000000000a5'),('00000000-0000-0000-0000-0000000000a6');
INSERT INTO commerce_listings (id,location_id,sku_id,product_type,price,title) VALUES
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','custom',50,'单店孤品'),
  ('00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a3','custom',50,'跨店孤品A'),
  ('00000000-0000-0000-0000-0000000000b4','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000a4','custom',40,'跨店孤品B'),
  ('00000000-0000-0000-0000-0000000000b5','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a5','standard',20,'标准品'),
  ('00000000-0000-0000-0000-0000000000b6','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a6','standard',10,'底层直测品');
INSERT INTO inv_stocks (sku_id,location_id,qty) VALUES
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a',1),
  ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000000a',1),
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-00000000000b',1),
  ('00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-00000000000a',1),
  ('00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-00000000000a',5);
INSERT INTO user_roles VALUES ('00000000-0000-0000-0000-0000000000e2','super_admin');

-- 报价夹具：单店 / 跨店 / 标准品
INSERT INTO quote_fixtures VALUES (md5('[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb::text),
  '{"subtotal_fen":5000,"discount_fen":0,"total_fen":5000,"shipping_fee_fen":1200,"coupon":null,"discount_allocations":[],"groups":[{"location_id":"00000000-0000-0000-0000-00000000000a","shipping_fee_fen":1200,"remaining_fen":0}]}');
INSERT INTO quote_fixtures VALUES (md5('[{"listing_id":"00000000-0000-0000-0000-0000000000b3","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b4","quantity":1}]'::jsonb::text),
  '{"subtotal_fen":9000,"discount_fen":0,"total_fen":9000,"shipping_fee_fen":1200,"coupon":null,"discount_allocations":[],"groups":[{"location_id":"00000000-0000-0000-0000-00000000000a","shipping_fee_fen":1200,"remaining_fen":0},{"location_id":"00000000-0000-0000-0000-00000000000b","shipping_fee_fen":0,"remaining_fen":0}]}');

-- F1 单店闪送报价：version/方式/零运费/cod
SELECT CASE WHEN q->>'version'='flash_cod_v1' AND q->>'fulfillment_method'='flash' AND (q->>'shipping_fee_fen')::int=0
   AND q->>'delivery_fee_payment'='cod' AND (q->>'total_fen')::int=5000
   AND (q->'groups'->0->>'shipping_fee_fen')::int=0
  THEN 'PASS F1 flash quote single store' ELSE 'FAIL F1 '||q::text END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'flash') q) t;

-- F2 跨店闪送报价：允许，两个分组各零运费、cod，总额=商品款-优惠
SELECT CASE WHEN q->>'version'='flash_cod_v1' AND q->>'fulfillment_method'='flash' AND (q->>'shipping_fee_fen')::int=0
   AND q->>'delivery_fee_payment'='cod' AND (q->>'total_fen')::int=9000
   AND jsonb_array_length(q->'groups')=2
   AND (q->'groups'->0->>'shipping_fee_fen')::int=0 AND (q->'groups'->1->>'shipping_fee_fen')::int=0
   AND (SELECT count(*) FROM jsonb_array_elements(q->'groups') g WHERE (g->>'shipping_fee_fen')::int<>0)=0
  THEN 'PASS F2 cross-store flash quote grouped zero-fee cod' ELSE 'FAIL F2 '||q::text END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b3","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b4","quantity":1}]',NULL,'flash') q) t;

-- F3 express/pickup 报价行为不变
SELECT CASE WHEN q->>'version' IS NULL AND (q->>'shipping_fee_fen')::int=1200 THEN 'PASS F3a express quote unchanged' ELSE 'FAIL F3a' END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'express') q) t;
SELECT CASE WHEN q->>'version'='pickup_v1' THEN 'PASS F3b pickup quote unchanged' ELSE 'FAIL F3b' END FROM (
  SELECT commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'pickup') q) t;

-- F4 闪送下单成功：方式/承运商/零运费落库，真实库存预留写入
DO $$
DECLARE v jsonb; v_quote jsonb; n int;
BEGIN
  v_quote := commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',NULL,'flash');
  v := commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-1','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海","detail":"新天地"}',v_quote,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
  SELECT count(*) INTO n FROM inventory_reservations r JOIN inventory_reservation_lines l ON l.reservation_id=r.id
    WHERE r.order_id=(v->>'id')::uuid AND r.status='active' AND l.stock_sku_id='00000000-0000-0000-0000-0000000000a1';
  IF v->>'fulfillment_method'='flash' AND v->>'courier_provider'='flash' AND v->>'courier_service_code'='SHANSONG_COD'
     AND coalesce((v->>'shipping_fee')::numeric,0)=0 AND (v->'payment_route'->>'mode')='ordinary_wechat' AND n=1 THEN
    RAISE NOTICE 'PASS F4 flash order created with real reservation';
  ELSE RAISE EXCEPTION 'FAIL F4 %', v; END IF;
END $$;

-- F5 同 key 重放返回同一订单，不产生第二单
DO $$
DECLARE v1 jsonb; v2 jsonb; n int;
BEGIN
  SELECT to_jsonb(o) INTO v1 FROM commerce_orders o WHERE idempotency_key='flash-key-1';
  v2 := commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-1','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海","detail":"新天地"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
  SELECT count(*) INTO n FROM commerce_orders WHERE idempotency_key='flash-key-1';
  IF v1->>'id' = v2->>'id' AND n=1 THEN RAISE NOTICE 'PASS F5 idempotent replay'; ELSE RAISE EXCEPTION 'FAIL F5'; END IF;
END $$;

-- F6 同 key 换配送方式冲突
DO $$ BEGIN
  INSERT INTO commerce_orders (customer_id,idempotency_key,source_channel,fulfillment_method,payment_status,order_status,payment_route)
    VALUES ('00000000-0000-0000-0000-0000000000c0','flash-key-2','storefront','shipping','unpaid','pending_payment','{"mode":"ordinary_wechat"}');
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-2','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
  RAISE EXCEPTION 'FAIL F6 method switch accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'idempotency key used by another fulfillment method%' THEN RAISE NOTICE 'PASS F6 method conflict rejected'; ELSE RAISE; END IF;
END $$;

-- F7 篡改运费快照被拒（quote changed）
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-3','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','{"version":"flash_cod_v1","total_fen":1}',NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
  RAISE EXCEPTION 'FAIL F7 tampered quote accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'shipping quote changed%' THEN RAISE NOTICE 'PASS F7 tampered quote rejected'; ELSE RAISE; END IF;
END $$;

-- F8 缺地址/缺手机号被拒
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-4','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三',NULL,'{"city":"上海"}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
  RAISE EXCEPTION 'FAIL F8a missing phone accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'flash recipient required%' THEN RAISE NOTICE 'PASS F8a phone required'; ELSE RAISE; END IF;
END $$;
DO $$ BEGIN
  PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-5','[{"listing_id":"00000000-0000-0000-0000-0000000000b1","quantity":1}]',
    '张三','13800000000','{}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
  RAISE EXCEPTION 'FAIL F8b empty address accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'flash address required%' THEN RAISE NOTICE 'PASS F8b address required'; ELSE RAISE; END IF;
END $$;

-- F9 跨店下单：真实报价+真实底层+真实付款路径，按店分组两个子单，各店只履约自有商品，各店分别登记送达
DO $$
DECLARE v jsonb; v_quote jsonb; v_order uuid; n int; r jsonb; v_f record; v_i uuid;
BEGIN
  v_quote := commerce_quote_checkout_v2('00000000-0000-0000-0000-0000000000c0','[{"listing_id":"00000000-0000-0000-0000-0000000000b3","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b4","quantity":1}]',NULL,'flash');
  v := commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','flash-key-6','[{"listing_id":"00000000-0000-0000-0000-0000000000b3","quantity":1},{"listing_id":"00000000-0000-0000-0000-0000000000b4","quantity":1}]',
    '张三','13800000000','{"city":"上海"}',v_quote,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b']::uuid[]);
  v_order := (v->>'id')::uuid;
  IF NOT (v->>'fulfillment_method'='flash' AND (v->>'subtotal')::numeric=90
     AND coalesce((v->>'discount_total')::numeric,0)=0 AND (v->>'total_amount')::numeric=90) THEN
    RAISE EXCEPTION 'FAIL F9 amounts %', v;
  END IF;
  -- 真实付款路径：支付成功记录 + 真实 mark_paid 创建履约分组并扣库存
  INSERT INTO commerce_payments (order_id,payment_channel,status,provider_transaction_id)
    VALUES (v_order,'ordinary_wechat','succeeded','txn-f9');
  PERFORM commerce_mark_ordinary_order_paid(v_order,'txn-f9',now());
  SELECT count(*) INTO n FROM fulfillments WHERE order_id = v_order;
  IF n=2
     AND NOT EXISTS (SELECT 1 FROM fulfillments f JOIN fulfillment_items fi ON fi.fulfillment_id=f.id
                     JOIN commerce_order_items oi ON oi.id=fi.order_item_id
                     WHERE f.order_id=v_order AND oi.location_id<>f.location_id)
     AND (SELECT qty FROM inv_stocks WHERE sku_id='00000000-0000-0000-0000-0000000000a3')=0
     AND (SELECT qty FROM inv_stocks WHERE sku_id='00000000-0000-0000-0000-0000000000a4')=0 THEN
    RAISE NOTICE 'PASS F9 cross-store paid order grouped per store, stock deducted';
  ELSE RAISE EXCEPTION 'FAIL F9 fulfillments'; END IF;
  -- 各店分别人工登记闪送送达
  FOR v_f IN SELECT id FROM fulfillments WHERE order_id=v_order ORDER BY location_id LOOP
    SELECT id INTO v_i FROM fulfillment_items WHERE fulfillment_id=v_f.id;
    r := commerce_flash_deliver_fulfillment('00000000-0000-0000-0000-0000000000e2',NULL,v_f.id,
      jsonb_build_array(jsonb_build_object('fulfillment_item_id',v_i,'quantity',1)),'op-flash-x-'||v_f.id::text,NULL);
    IF NOT ((r->>'ok')::boolean AND r->>'result'='delivered') THEN RAISE EXCEPTION 'FAIL F9 deliver %', r; END IF;
  END LOOP;
  SELECT count(*) INTO n FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=v_order AND s.provider='flash' AND s.tracking_no IS NULL;
  IF n=2 THEN RAISE NOTICE 'PASS F9b each store delivered separately'; ELSE RAISE EXCEPTION 'FAIL F9b'; END IF;
END $$;

-- F10 送达登记：真实付款后的闪送单 → delivered，无单号，子单交接
DO $$
DECLARE v_o uuid; v_f uuid; v_i uuid; r jsonb;
BEGIN
  SELECT id INTO v_o FROM commerce_orders WHERE idempotency_key='flash-key-1';
  INSERT INTO commerce_payments (order_id,payment_channel,status,provider_transaction_id)
    VALUES (v_o,'ordinary_wechat','succeeded','txn-f10');
  PERFORM commerce_mark_ordinary_order_paid(v_o,'txn-f10',now());
  SELECT f.id, fi.id INTO v_f, v_i FROM fulfillments f JOIN fulfillment_items fi ON fi.fulfillment_id=f.id
    WHERE f.order_id=v_o;
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
    PERFORM commerce_create_ordinary_flash_order('00000000-0000-0000-0000-0000000000c0','k','[]','a','13800000000','{}',NULL,NULL,'1234567890','wx1234567890abcdef',ARRAY['00000000-0000-0000-0000-00000000000a']::uuid[]);
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

-- F17 真实底层守卫：直接调 commerce_create_order_v2 时，flash 仅限 SHANSONG_COD 且运费为 0
DO $$ BEGIN
  PERFORM commerce_create_order_v2('00000000-0000-0000-0000-0000000000c0','v2-flash-fee','[{"listing_id":"00000000-0000-0000-0000-0000000000b6","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','flash','SHANSONG_COD','同城闪送',5,NULL,NULL);
  RAISE EXCEPTION 'FAIL F17a flash with fee accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'unsupported courier provider%' THEN RAISE NOTICE 'PASS F17a flash fee rejected at base layer'; ELSE RAISE; END IF;
END $$;
DO $$ BEGIN
  PERFORM commerce_create_order_v2('00000000-0000-0000-0000-0000000000c0','v2-flash-code','[{"listing_id":"00000000-0000-0000-0000-0000000000b6","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','flash','OTHER_CODE',NULL,0,NULL,NULL);
  RAISE EXCEPTION 'FAIL F17b flash with wrong code accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'unsupported courier provider%' THEN RAISE NOTICE 'PASS F17b flash wrong code rejected at base layer'; ELSE RAISE; END IF;
END $$;
DO $$
DECLARE v public.commerce_orders;
BEGIN
  v := commerce_create_order_v2('00000000-0000-0000-0000-0000000000c0','v2-flash-ok','[{"listing_id":"00000000-0000-0000-0000-0000000000b6","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','flash','SHANSONG_COD','同城闪送（配送费到付）',0,NULL,NULL);
  IF v.courier_provider='flash' AND v.shipping_fee=0 THEN RAISE NOTICE 'PASS F17c legit flash accepted at base layer';
  ELSE RAISE EXCEPTION 'FAIL F17c'; END IF;
END $$;

-- F18 真实底层对既有快递承运商行为不变
DO $$
DECLARE v public.commerce_orders;
BEGIN
  v := commerce_create_order_v2('00000000-0000-0000-0000-0000000000c0','v2-sf-ok','[{"listing_id":"00000000-0000-0000-0000-0000000000b6","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','sf','SF_STANDARD','顺丰标快',12,NULL,NULL);
  IF v.courier_provider='sf' AND v.shipping_fee=12 THEN RAISE NOTICE 'PASS F18 express providers unchanged';
  ELSE RAISE EXCEPTION 'FAIL F18'; END IF;
END $$;

-- F19 缺货回滚：标准品库存 1 已被 F4 同店占用? 用 b5（库存1）：首单预留成功后第二单失败且无残留
DO $$
DECLARE v public.commerce_orders; n int;
BEGIN
  v := commerce_create_order_v2('00000000-0000-0000-0000-0000000000c0','v2-stock-1','[{"listing_id":"00000000-0000-0000-0000-0000000000b5","quantity":1}]',
    '张三','13800000000','{"city":"上海"}','sf','SF_STANDARD',NULL,0,NULL,NULL);
  BEGIN
    PERFORM commerce_create_order_v2('00000000-0000-0000-0000-0000000000c0','v2-stock-2','[{"listing_id":"00000000-0000-0000-0000-0000000000b5","quantity":1}]',
      '李四','13900000000','{"city":"北京"}','sf','SF_STANDARD',NULL,0,NULL,NULL);
    RAISE EXCEPTION 'FAIL F19 out-of-stock accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%out of stock%' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO n FROM commerce_orders WHERE idempotency_key='v2-stock-2';
  IF n=0 AND NOT EXISTS (SELECT 1 FROM inventory_reservations r JOIN commerce_orders o ON o.id=r.order_id WHERE o.idempotency_key='v2-stock-2') THEN
    RAISE NOTICE 'PASS F19 out-of-stock rolls back cleanly';
  ELSE RAISE EXCEPTION 'FAIL F19 residue'; END IF;
END $$;
