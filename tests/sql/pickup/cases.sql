\set ON_ERROR_STOP 1
-- 常量
\set A '''a0000000-0000-4000-8000-000000000001'''
\set B '''a0000000-0000-4000-8000-000000000002'''
\set SA '''b0000000-0000-4000-8000-00000000000a'''
\set SB '''b0000000-0000-4000-8000-00000000000b'''
\set HQ '''b0000000-0000-4000-8000-00000000000c'''
\set NOROLE '''b0000000-0000-4000-8000-00000000000d'''
\set SE '''b0000000-0000-4000-8000-00000000000e'''
CREATE TEMP TABLE t AS SELECT 1;
DO $$ DECLARE o uuid; o2 uuid; c record; r jsonb; n int; tok text; v_pc text; BEGIN
  -- 1 未付款无凭证；付款事务内生成，每门店一条
  INSERT INTO commerce_orders(fulfillment_method) VALUES ('pickup') RETURNING id INTO o;
  ASSERT (SELECT count(*) FROM commerce_pickup_codes WHERE order_id=o)=0, 'unpaid must have no code';
  PERFORM test_mark_paid(o, ARRAY['a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002']::uuid[]);
  ASSERT (SELECT count(*) FROM commerce_pickup_codes WHERE order_id=o)=2, 'one code per store sub-order';
  SELECT code, qr_token INTO v_pc, tok FROM commerce_pickup_codes WHERE order_id=o AND location_id='a0000000-0000-4000-8000-000000000001';
  ASSERT v_pc ~ '^[0-9]{4}$' AND length(tok)=64, 'code format';
  -- 2 支付重放不换码
  UPDATE commerce_orders SET payment_status='paid' WHERE id=o;
  PERFORM commerce_pickup_issue_codes(o);
  ASSERT (SELECT qr_token FROM commerce_pickup_codes WHERE order_id=o AND location_id='a0000000-0000-4000-8000-000000000001')=tok, 'replay keeps code';
  -- 3 快递单不生成
  INSERT INTO commerce_orders DEFAULT VALUES RETURNING id INTO o2;
  PERFORM test_mark_paid(o2, ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
  ASSERT (SELECT count(*) FROM commerce_pickup_codes WHERE order_id=o2)=0, 'express gets no code';
  -- 4 越权：别店员工 / 无角色 / 非门店库位
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001',NULL,v_pc,'idem-cross-1');
  ASSERT r->>'result'='forbidden', 'other store staff forbidden: '||r;
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000d','a0000000-0000-4000-8000-000000000001',NULL,v_pc,'idem-norole-1');
  ASSERT r->>'result'='forbidden', 'perm without staff role forbidden';
  -- 5 错店扫码：B 店员工扫 A 店二维码
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000002','BOOMER_PICKUP:'||tok,NULL,'idem-wrong-1');
  ASSERT r->>'result'='wrong_location', 'wrong store qr: '||r;
  -- 6 未备货拒绝
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'idem-notready-1');
  ASSERT r->>'result'='not_ready', 'not ready: '||r;
  -- 7 备货完成 → 核销；别店员工不能备货
  r := commerce_pickup_mark_ready('b0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000001',
        (SELECT fulfillment_id FROM commerce_pickup_codes WHERE qr_token=tok),'ready-cross-1');
  ASSERT r->>'result'='forbidden', 'cross-store ready forbidden';
  r := commerce_pickup_mark_ready('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001',
        (SELECT fulfillment_id FROM commerce_pickup_codes WHERE qr_token=tok),'ready-a-1');
  ASSERT r->>'result'='ready', 'ready: '||r;
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001',NULL,v_pc,'idem-ok-1');
  ASSERT r->>'result'='redeemed', 'manual code redeem: '||r;
  ASSERT (SELECT status FROM fulfillments WHERE id=(r->>'fulfillment_id')::uuid)='handed_over', 'handed_over';
  ASSERT (SELECT order_status FROM commerce_orders WHERE id=o)='processing', 'other store still open';
  ASSERT (SELECT count(*) FROM inv_stock_movements)=0, 'no stock movement';
  -- 8 重复扫码：已核销，不重复；同幂等键重放返回原结果
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000e','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'idem-dup-2');
  ASSERT r->>'result'='already_redeemed', 'dup scan: '||r;
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001',NULL,v_pc,'idem-ok-1');
  ASSERT r->>'result'='redeemed' AND (r->>'replayed')::boolean, 'idempotent replay';
  ASSERT (SELECT count(*) FROM commerce_pickup_audit WHERE result='redeemed')=1, 'single redeem audit';
  -- 9 HQ 跨店：核销 B 店子单后订单完成
  SELECT * INTO c FROM commerce_pickup_codes WHERE order_id=o AND location_id='a0000000-0000-4000-8000-000000000002';
  PERFORM commerce_pickup_mark_ready('b0000000-0000-4000-8000-00000000000c','a0000000-0000-4000-8000-000000000002',c.fulfillment_id,'ready-hq-1');
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000c','a0000000-0000-4000-8000-000000000002','BOOMER_PICKUP:'||c.qr_token,NULL,'idem-hq-1');
  ASSERT r->>'result'='redeemed', 'hq redeem';
  ASSERT (SELECT order_status FROM commerce_orders WHERE id=o)='completed', 'order completed when all handed over';
  -- 10 已核销后四位码释放，未知码拒绝
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001',NULL,v_pc,'idem-freed-1');
  ASSERT r->>'result'='not_found', 'redeemed code no longer matches by digits';
  RAISE NOTICE 'PASS pickup basic/authz/idempotency/cross-store';
END $$;

DO $$ DECLARE o uuid; r jsonb; tok text; f uuid; BEGIN
  -- 11 退款中 / 已退款 / 取消 / 缺货待确认 阻断
  INSERT INTO commerce_orders(fulfillment_method) VALUES ('pickup') RETURNING id INTO o;
  PERFORM test_mark_paid(o, ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
  SELECT qr_token, fulfillment_id INTO tok, f FROM commerce_pickup_codes WHERE order_id=o;
  PERFORM commerce_pickup_mark_ready('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001',f,'ready-ref-1');
  INSERT INTO fulfillment_shortages(fulfillment_id,status) VALUES (f,'pending_customer');
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'idem-short-1');
  ASSERT r->>'result'='shortage_blocked', 'shortage: '||r;
  UPDATE fulfillment_shortages SET status='withdrawn' WHERE fulfillment_id=f;
  INSERT INTO commerce_refund_intents(order_id,state) VALUES (o,'queued');
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'idem-ri-1');
  ASSERT r->>'result'='refund_blocked', 'refund intent: '||r;
  DELETE FROM commerce_refund_intents WHERE order_id=o;
  UPDATE commerce_orders SET payment_status='refund_pending' WHERE id=o;
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'idem-rp-1');
  ASSERT r->>'result'='refund_blocked', 'refund pending: '||r;
  UPDATE commerce_orders SET payment_status='refunded', order_status='closed' WHERE id=o;
  ASSERT (SELECT status FROM commerce_pickup_codes WHERE order_id=o)='void', 'refunded voids code';
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'idem-rf-1');
  ASSERT r->>'result'='cancelled', 'refunded: '||r;
  ASSERT (SELECT status FROM fulfillments WHERE id=f)='handover_ready', 'not handed over';
  RAISE NOTICE 'PASS pickup refund/shortage/cancel blocking';
END $$;

DO $$ DECLARE r jsonb; i int; BEGIN
  -- 12 手输限速：5 次未知码后锁定；必须显式门店
  FOR i IN 1..5 LOOP
    r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000e','a0000000-0000-4000-8000-000000000001',NULL,'9999','idem-guess-'||i);
  END LOOP;
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000e','a0000000-0000-4000-8000-000000000001',NULL,'0000','idem-guess-x');
  ASSERT r->>'result'='rate_limited', 'rate limit: '||r;
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a',NULL,NULL,'0000','idem-noloc-1');
  ASSERT r->>'result'='invalid_input', 'location required';
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','https://x/BOOMER_PICKUP',NULL,'idem-bad-1');
  ASSERT r->>'result'='invalid_input', 'bad qr';
  RAISE NOTICE 'PASS pickup rate limit/input';
END $$;

DO $$ DECLARE q jsonb; o jsonb; o2 jsonb; BEGIN
  -- 13 报价 pickup 同 shape 运费 0；express 原样
  q := commerce_quote_checkout_v2('c0000000-0000-4000-8000-000000000001','[]'::jsonb,NULL,'express');
  ASSERT q->>'version'='per_store_99_cross_299_v1' AND (q->>'shipping_fee_fen')::int=990, 'express unchanged';
  q := commerce_quote_checkout_v2('c0000000-0000-4000-8000-000000000001','[]'::jsonb,NULL,'pickup');
  ASSERT q->>'version'='pickup_v1' AND q->>'fulfillment_method'='pickup' AND (q->>'shipping_fee_fen')::int=0
     AND (q->>'total_fen')::int=5000 AND (q->'groups'->0->>'shipping_fee_fen')::int=0, 'pickup quote: '||q;
  -- 14 自提下单：快照被改拒绝；幂等；同键换方式拒绝
  INSERT INTO commerce_customers VALUES ('c0000000-0000-4000-8000-000000000001','active');
  INSERT INTO inv_skus(id) VALUES ('d0000000-0000-4000-8000-000000000001');
  INSERT INTO commerce_listings VALUES ('e0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001');
  BEGIN
    PERFORM commerce_create_ordinary_pickup_order('c0000000-0000-4000-8000-000000000001','idem-order-1',
      '[{"listing_id":"e0000000-0000-4000-8000-000000000001","quantity":1}]','张','13800000000',
      q || '{"total_fen":1}'::jsonb,NULL,'1234567890','wx1234567890abcdef',ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
    RAISE EXCEPTION 'tampered snapshot must fail';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM='shipping quote changed', 'tamper error: '||SQLERRM;
  END;
  o := commerce_create_ordinary_pickup_order('c0000000-0000-4000-8000-000000000001','idem-order-1',
      '[{"listing_id":"e0000000-0000-4000-8000-000000000001","quantity":1}]','张','13800000000',
      q,NULL,'1234567890','wx1234567890abcdef',ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
  ASSERT o->>'fulfillment_method'='pickup' AND o->>'courier_service_code'='STORE_PICKUP' AND (o->>'shipping_fee')::numeric=0
     AND o->'shipping_address'='{}'::jsonb AND o->'payment_route'->>'mode'='ordinary_wechat', 'pickup order: '||o;
  o2 := commerce_create_ordinary_pickup_order('c0000000-0000-4000-8000-000000000001','idem-order-1',
      '[{"listing_id":"e0000000-0000-4000-8000-000000000001","quantity":1}]','张','13800000000',
      q,NULL,'1234567890','wx1234567890abcdef',ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
  ASSERT o2->>'id'=o->>'id', 'idempotent create';
  UPDATE commerce_orders SET fulfillment_method='shipping' WHERE idempotency_key='idem-order-2';
  INSERT INTO commerce_orders(customer_id, idempotency_key, payment_route) VALUES
    ('c0000000-0000-4000-8000-000000000001','idem-order-2','{"mode":"ordinary_wechat"}');
  BEGIN
    PERFORM commerce_create_ordinary_pickup_order('c0000000-0000-4000-8000-000000000001','idem-order-2',
      '[{"listing_id":"e0000000-0000-4000-8000-000000000001","quantity":1}]','张','13800000000',
      q,NULL,'1234567890','wx1234567890abcdef',ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
    RAISE EXCEPTION 'method switch must fail';
  EXCEPTION WHEN raise_exception THEN
    ASSERT SQLERRM='idempotency key used by another fulfillment method', SQLERRM;
  END;
  RAISE NOTICE 'PASS pickup quote/create/idempotency';
END $$;

DO $$ BEGIN
  ASSERT NOT has_function_privilege('authenticated','commerce_pickup_redeem(uuid,uuid,text,text,text,uuid)','execute'), 'no client execute';
  ASSERT NOT has_function_privilege('anon','commerce_pickup_mark_ready(uuid,uuid,uuid,text)','execute'), 'no anon execute';
  ASSERT NOT has_table_privilege('authenticated','commerce_pickup_codes','select'), 'no client select';
  RAISE NOTICE 'PASS pickup grants';
END $$;
