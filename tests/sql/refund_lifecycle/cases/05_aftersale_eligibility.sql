-- 0055：实际售后表活跃状态、complete_pick 全部清算阻断、顾客自提服务端资格（per-fulfillment）。
\set ON_ERROR_STOP 0
-- N1 after_sale 订单不得完成配货（独立事务，回滚）
BEGIN;
SELECT t_order('n1','shipping',10); SELECT t_ful('fn1','n1','A','picking'); SELECT t_item('in1','fn1',1,1);
UPDATE commerce_orders SET order_status='after_sale' WHERE id=t_id('n1');
DO $$ BEGIN
  PERFORM fulfillment_complete_pick(t_id('fn1'),'aaaaaaaa-0000-4000-8000-00000000000a',NULL);
  RAISE EXCEPTION 'N1 complete_pick accepted after_sale order';
EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'N1%' THEN RAISE; END IF;
  ASSERT SQLERRM LIKE '%after_sale_blocked%', 'N1 reason: '||SQLERRM; RAISE NOTICE 'PASS N1 complete_pick blocks after_sale order'; END $$;
ROLLBACK;
-- N2 unpaid 订单不得完成配货
BEGIN;
SELECT t_order('n2','shipping',10); SELECT t_ful('fn2','n2','A','picking'); SELECT t_item('in2','fn2',1,1);
UPDATE commerce_orders SET payment_status='unpaid' WHERE id=t_id('n2');
DO $$ BEGIN
  PERFORM fulfillment_complete_pick(t_id('fn2'),'aaaaaaaa-0000-4000-8000-00000000000a',NULL);
  RAISE EXCEPTION 'N2 complete_pick accepted unpaid order';
EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'N2%' THEN RAISE; END IF;
  ASSERT SQLERRM LIKE '%unpaid%', 'N2 reason: '||SQLERRM; RAISE NOTICE 'PASS N2 complete_pick blocks unpaid order'; END $$;
ROLLBACK;
-- N3 父订单 paid/processing 但有活跃 refund_only 售后（requested）→ 手工发货必须拒绝且不留写入
BEGIN;
SELECT t_order('n3','shipping',10); SELECT t_ful('fn3','n3','A','picked'); SELECT t_item('in3','fn3',1,1);
INSERT INTO commerce_after_sales(id,order_id,type,status) VALUES (t_id('n3:as'),t_id('n3'),'refund_only','requested');
DO $$ DECLARE r jsonb; s text; BEGIN
  r := t_ship('fn3', jsonb_build_array(t_line('in3',1)), 'ship-n3-0001');
  ASSERT coalesce(r->>'ok','false')='false' AND r->>'result'='after_sale_blocked', 'N3 manual ship with active after-sale: '||r::text;
  SELECT status INTO s FROM fulfillments WHERE id=t_id('fn3'); ASSERT s='picked', 'N3 status changed';
  RAISE NOTICE 'PASS N3 manual ship blocked by active after-sale row'; END $$;
-- 每个活跃状态都阻断，终态不阻断
DO $$ DECLARE st text; b text; BEGIN
  FOREACH st IN ARRAY ARRAY['requested','store_reviewing','approved','customer_shipping','store_received','inspecting','refund_pending'] LOOP
    UPDATE commerce_after_sales SET status=st WHERE id=t_id('n3:as');
    b := commerce_order_settlement_block(t_id('n3')); ASSERT b='after_sale_blocked', 'N3 active '||st||': '||coalesce(b,'null');
  END LOOP;
  FOREACH st IN ARRAY ARRAY['rejected','closed','cancelled'] LOOP
    UPDATE commerce_after_sales SET status=st WHERE id=t_id('n3:as');
    b := commerce_order_settlement_block(t_id('n3')); ASSERT b IS NULL, 'N3 terminal '||st||': '||coalesce(b,'null');
  END LOOP;
  RAISE NOTICE 'PASS N3b active after-sale statuses block, terminal statuses do not'; END $$;
ROLLBACK;
-- N4 已结清缺货售后（after_sale=refunded）不阻断合法剩余交付（S1 已建链）
DO $$ BEGIN
  ASSERT (SELECT status FROM commerce_after_sales WHERE id=t_id('s1:as'))='refunded', 'N4 shortage after-sale should be refunded';
  ASSERT commerce_order_settlement_block(t_id('o1')) IS NULL, 'N4 cleared shortage after-sale must not block';
  RAISE NOTICE 'PASS N4 settled shortage after-sale does not block remaining delivery'; END $$;

-- 顾客自提资格
SELECT t_order('e1','pickup',20); SELECT t_ful('fe1','e1','A','allocated'); SELECT t_item('ie11','fe1',1,0); SELECT t_item('ie12','fe1',1,0);
SELECT t_shortage('se1','e1','fe1','ie12',1,1000); SELECT t_clear('se1','e1',1000);
SELECT t_order('e2','pickup',20); SELECT t_ful('fe2a','e2','A','allocated'); SELECT t_ful('fe2b','e2','B','allocated');
SELECT t_item('ie2a','fe2a',1,0); SELECT t_item('ie2b','fe2b',1,0); SELECT t_shortage('se2','e2','fe2a','ie2a',1,1000); SELECT t_clear('se2','e2',1000);
SELECT t_order('e3','pickup',20); SELECT t_ful('fe3a','e3','A','allocated'); SELECT t_ful('fe3b','e3','B','allocated');
SELECT t_item('ie3a','fe3a',1,0); SELECT t_item('ie3b','fe3b',1,0); SELECT t_shortage('se3','e3','fe3a','ie3a',1,1000); SELECT t_claim('se3');
SELECT t_order('e4','pickup',20); SELECT t_ful('fe4','e4','A','allocated'); SELECT t_item('ie41','fe4',1,0);
INSERT INTO commerce_after_sales(id,order_id,type,status) VALUES (t_id('e4:as'),t_id('e4'),'refund_only','refund_pending'); SELECT t_refund_apply('re4','e4','e4:as',5);
SELECT t_order('e5','pickup',20); SELECT t_ful('fe5','e5','A','allocated'); SELECT t_item('ie51','fe5',1,0); SELECT t_item('ie52','fe5',1,0);
SELECT t_shortage('se5','e5','fe5','ie52',1,1000); UPDATE fulfillment_shortages SET refund_state='refund_completed' WHERE id=t_id('se5');
DO $$ DECLARE m jsonb; BEGIN
  SELECT jsonb_object_agg(fulfillment_id::text, coalesce(block_reason,'OK')) INTO m
    FROM commerce_storefront_pickup_eligibility(ARRAY[t_id('e1'),t_id('e2'),t_id('e3'),t_id('e4'),t_id('e5')]);
  ASSERT (SELECT payment_status FROM commerce_orders WHERE id=t_id('e1'))='partially_refunded', 'E1 setup';
  ASSERT m->>t_id('fe1')::text='OK', 'E1 cleared shortage remaining pickup eligible: '||m::text;
  ASSERT m->>t_id('fe2a')::text='shortage_blocked' AND m->>t_id('fe2b')::text='OK', 'E2 cross-store cleared: '||m::text;
  ASSERT m->>t_id('fe3a')::text='refund_blocked' AND m->>t_id('fe3b')::text='refund_blocked', 'E3 unsettled cross-store conservative: '||m::text;
  ASSERT m->>t_id('fe4')::text='refund_blocked', 'E4 non-shortage partial refund: '||m::text;
  ASSERT m->>t_id('fe5')::text='refund_blocked', 'E5 forged refund_completed: '||m::text;
  RAISE NOTICE 'PASS E1-E5 storefront pickup eligibility'; END $$;
DO $$ BEGIN
  ASSERT NOT has_function_privilege('anon','commerce_storefront_pickup_eligibility(uuid[])','EXECUTE')
     AND NOT has_function_privilege('authenticated','commerce_storefront_pickup_eligibility(uuid[])','EXECUTE')
     AND has_function_privilege('service_role','commerce_storefront_pickup_eligibility(uuid[])','EXECUTE'), 'E6 grants';
  RAISE NOTICE 'PASS E6 eligibility service_role only'; END $$;
