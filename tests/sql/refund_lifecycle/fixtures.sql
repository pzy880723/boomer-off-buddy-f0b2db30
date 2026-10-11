\set ON_ERROR_STOP 1
-- 夹具：订单/支付/缺货/售后/退款意图按真实结构建立；“退款成功”一律经现行 commerce_apply_ordinary_refund
-- 与 commerce_settle_refund_intent 驱动（不直接手写 succeeded/partially_refunded）。
INSERT INTO inv_locations(id,name,kind,is_active) VALUES
 ('aaaaaaaa-0000-4000-8000-00000000000a','A店','shop',true),('aaaaaaaa-0000-4000-8000-00000000000b','B店','shop',true);
INSERT INTO user_roles(user_id,role) VALUES ('aaaaaaaa-0000-4000-8000-0000000000f1','hq_operator'),('aaaaaaaa-0000-4000-8000-0000000000f2','store_staff');
INSERT INTO user_location_perms(user_id,location_id) VALUES ('aaaaaaaa-0000-4000-8000-0000000000f2','aaaaaaaa-0000-4000-8000-00000000000a');

-- 建单：t_order(tag, method, total)；t_ful(tag, order, loc, status)；t_item(tag, ful, expected, picked)
CREATE FUNCTION t_id(tag text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('rl:'||tag)::uuid $$;
CREATE FUNCTION t_order(tag text, method text, total numeric) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO commerce_orders(id,payment_status,order_status,fulfillment_method,total_amount,source_channel,customer_id,paid_at)
    VALUES (t_id(tag),'paid','processing',method,total,'storefront',t_id('cust'),now());
  INSERT INTO commerce_payments(id,order_id,provider,status,amount,provider_transaction_id,payment_channel,paid_at)
    VALUES (t_id(tag||':pay'),t_id(tag),'wechat','succeeded',total,'tx-'||tag,'ordinary_wechat',now());
END $$;
CREATE FUNCTION t_ful(tag text, ord text, loc text, st text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO fulfillments(id,order_id,location_id,status) VALUES (t_id(tag),t_id(ord),
    CASE loc WHEN 'A' THEN 'aaaaaaaa-0000-4000-8000-00000000000a'::uuid ELSE 'aaaaaaaa-0000-4000-8000-00000000000b'::uuid END, st) $$;
CREATE FUNCTION t_item(tag text, ful text, e int, p int) RETURNS void LANGUAGE sql AS $$
  INSERT INTO fulfillment_items(id,fulfillment_id,expected_qty,picked_qty,packed_qty) VALUES (t_id(tag),t_id(ful),e,p,0) $$;
-- 缺货 + 客户确认（与 shortage_confirm_refund_v1 写入一致：customer_accepted/queued + after_sale + intent queued）
CREATE FUNCTION t_shortage(tag text, ord text, ful text, item text, qty int, fen int) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO commerce_after_sales(id,order_id,type,status,reason_code) VALUES (t_id(tag||':as'),t_id(ord),'refund_only','refund_pending','stock_shortage');
  INSERT INTO commerce_refund_intents(id,shortage_id,order_id,customer_id,payment_id,after_sale_id,amount_fen,goods_fen,idempotency_key,state)
    VALUES (t_id(tag||':ri'),t_id(tag),t_id(ord),t_id('cust'),t_id(ord||':pay'),t_id(tag||':as'),fen,fen,'ri-'||tag,'queued');
  INSERT INTO fulfillment_shortages(id,fulfillment_id,fulfillment_item_id,order_id,quantity,status,refund_state,refund_total_fen,after_sale_id,refund_intent_id)
    VALUES (t_id(tag),t_id(ful),t_id(item),t_id(ord),qty,'customer_accepted','queued',fen,t_id(tag||':as'),t_id(tag||':ri'));
END $$;
-- worker 认领：intent → processing + lease（同 claim 语义），并经 settle 同步缺货 refund_state
CREATE FUNCTION t_claim(tag text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  UPDATE commerce_refund_intents SET state='processing', lease_token=t_id(tag||':lease'), lease_expires_at=now()+interval '5 min' WHERE id=t_id(tag||':ri');
  UPDATE fulfillment_shortages SET refund_state='processing' WHERE id=t_id(tag);
END $$;
-- 真实退款：建 commerce_refunds(processing) → 现行 commerce_apply_ordinary_refund(succeeded 事件)
CREATE FUNCTION t_refund_apply(tag text, ord text, as_tag text, amount numeric) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p commerce_payments; BEGIN
  SELECT * INTO p FROM commerce_payments WHERE id=t_id(ord||':pay');
  INSERT INTO commerce_refunds(id,order_id,payment_id,after_sale_id,provider,status,amount,idempotency_key,merchant_refund_no,route_snapshot)
    VALUES (t_id(tag),t_id(ord),p.id,t_id(as_tag),'wechat','processing',amount,'rf-'||tag,'MR'||substr(md5(tag),1,20),'{"merchant_id":"m1"}');
  RETURN commerce_apply_ordinary_refund(jsonb_build_object('event_id','ev-'||tag,'status','succeeded','provider_refund_id','prf-'||tag,
    'merchant_id','m1','transaction_id',p.provider_transaction_id,'total_fen',p.amount*100,'refund_fen',amount*100,
    'refunded_at',now()::text,'merchant_refund_no','MR'||substr(md5(tag),1,20)));
END $$;
CREATE FUNCTION t_settle(tag text, st text, refund_tag text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT commerce_settle_refund_intent(t_id(tag||':ri'), t_id(tag||':lease'), st, NULL, CASE WHEN refund_tag IS NULL THEN NULL ELSE t_id(refund_tag) END, 0) $$;
-- 一条完整“缺货退款成功”链
CREATE FUNCTION t_clear(tag text, ord text, fen int) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  PERFORM t_claim(tag); PERFORM t_refund_apply(tag||':rf', ord, tag||':as', fen/100.0); PERFORM t_settle(tag,'succeeded',tag||':rf');
END $$;
CREATE FUNCTION t_ship(ful text, lines jsonb, key text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT commerce_manual_ship_fulfillment('aaaaaaaa-0000-4000-8000-0000000000f1'::uuid,NULL,t_id(ful),'sf','SF'||upper(substr(md5(key),1,10)),lines,'key-ship-'||key) $$;
CREATE FUNCTION t_line(item text, q int) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('fulfillment_item_id',t_id(item),'quantity',q) $$;

-- S1 单店两件：一件缺货已退款成功，另一件正常
SELECT t_order('o1','shipping',20); SELECT t_ful('f1','o1','A','picked'); SELECT t_item('i11','f1',1,1); SELECT t_item('i12','f1',1,0);
SELECT t_shortage('s1','o1','f1','i12',1,1000); SELECT t_clear('s1','o1',1000);
-- S2 跨店：A 店整行缺货清算，B 店正常
SELECT t_order('o2','shipping',20); SELECT t_ful('f2a','o2','A','picking'); SELECT t_ful('f2b','o2','B','picked');
SELECT t_item('i2a','f2a',1,0); SELECT t_item('i2b','f2b',1,1); SELECT t_shortage('s2','o2','f2a','i2a',1,1000); SELECT t_clear('s2','o2',1000);
-- S3..S6 退款未清算：queued / processing / failed / manual_review
SELECT t_order('o3','shipping',20); SELECT t_ful('f3','o3','A','picked'); SELECT t_item('i31','f3',1,1); SELECT t_item('i32','f3',1,0); SELECT t_shortage('s3','o3','f3','i32',1,1000);
SELECT t_order('o4','shipping',20); SELECT t_ful('f4','o4','A','picked'); SELECT t_item('i41','f4',1,1); SELECT t_item('i42','f4',1,0); SELECT t_shortage('s4','o4','f4','i42',1,1000); SELECT t_claim('s4');
SELECT t_order('o5','shipping',20); SELECT t_ful('f5','o5','A','picked'); SELECT t_item('i51','f5',1,1); SELECT t_item('i52','f5',1,0); SELECT t_shortage('s5','o5','f5','i52',1,1000); SELECT t_claim('s5'); SELECT t_settle('s5','failed',NULL);
SELECT t_order('o6','shipping',20); SELECT t_ful('f6','o6','A','picked'); SELECT t_item('i61','f6',1,1); SELECT t_item('i62','f6',1,0); SELECT t_shortage('s6','o6','f6','i62',1,1000); SELECT t_claim('s6'); SELECT t_settle('s6','manual_review',NULL);
-- S7 全额退款（经真实 apply，订单 refunded + closed）
SELECT t_order('o7','shipping',10); SELECT t_ful('f7','o7','A','picked'); SELECT t_item('i71','f7',1,1);
INSERT INTO commerce_after_sales(id,order_id,type,status) VALUES (t_id('as7'),t_id('o7'),'refund_only','refund_pending'); SELECT t_refund_apply('r7','o7','as7',10);
-- S8 与缺货无关的部分退款（普通售后）→ partially_refunded 但不得放行
SELECT t_order('o8','shipping',20); SELECT t_ful('f8','o8','A','picked'); SELECT t_item('i81','f8',1,1);
INSERT INTO commerce_after_sales(id,order_id,type,status) VALUES (t_id('as8'),t_id('o8'),'refund_only','refund_pending'); SELECT t_refund_apply('r8','o8','as8',5);
-- S9 自提：一件缺货清算，另一件正常；S10 自提退款处理中
SELECT t_order('o9','pickup',20); SELECT t_ful('f9','o9','A','allocated'); SELECT t_item('i91','f9',1,0); SELECT t_item('i92','f9',1,0);
SELECT t_shortage('s9','o9','f9','i92',1,1000); SELECT t_clear('s9','o9',1000);
INSERT INTO commerce_pickup_codes(order_id,fulfillment_id,location_id,code,qr_token) VALUES (t_id('o9'),t_id('f9'),'aaaaaaaa-0000-4000-8000-00000000000a','4821',encode(digest('q9','sha256'),'hex'));
SELECT t_order('o10','pickup',20); SELECT t_ful('f10','o10','A','allocated'); SELECT t_item('i101','f10',1,0); SELECT t_item('i102','f10',1,0);
SELECT t_shortage('s10','o10','f10','i102',1,1000); SELECT t_claim('s10');
-- S11 拣货完成：缺货清算后剩余已拣
SELECT t_order('o11','shipping',20); SELECT t_ful('f11','o11','A','picking'); SELECT t_item('i111','f11',1,1); SELECT t_item('i112','f11',1,0);
SELECT t_shortage('s11','o11','f11','i112',1,1000); SELECT t_clear('s11','o11',1000);
-- S12 伪造字符串：refund_state 写成 refund_completed / succeeded 但无真实退款证据
SELECT t_order('o12','shipping',20); SELECT t_ful('f12','o12','A','picked'); SELECT t_item('i121','f12',1,1); SELECT t_item('i122','f12',1,0);
SELECT t_shortage('s12','o12','f12','i122',1,1000); UPDATE fulfillment_shortages SET refund_state='refund_completed' WHERE id=t_id('s12');
SELECT t_order('o13','shipping',20); SELECT t_ful('f13','o13','A','picked'); SELECT t_item('i131','f13',1,1); SELECT t_item('i132','f13',1,0);
SELECT t_shortage('s13','o13','f13','i132',1,1000); SELECT t_claim('s13'); UPDATE fulfillment_shortages SET refund_state='succeeded' WHERE id=t_id('s13');
