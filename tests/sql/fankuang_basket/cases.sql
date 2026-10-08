-- 翻筐乐分筐 / 翻动 / 赠礼资格 / 下单原子消耗 行为用例（隔离库）。
\set ON_ERROR_STOP on
INSERT INTO inv_locations(id,name) VALUES
 ('10000000-0000-4000-8000-000000000001','A店'),('10000000-0000-4000-8000-000000000002','B店'),
 ('10000000-0000-4000-8000-000000000003','C店');
INSERT INTO commerce_customers(id) VALUES ('c0000000-0000-4000-8000-000000000001'),('c0000000-0000-4000-8000-000000000002');
-- 250 件可参与商品，分布 A/B 两店
INSERT INTO inv_skus(id, price_tier) SELECT md5('sku'||g)::uuid, 20 FROM generate_series(1,250) g;
INSERT INTO inv_stocks SELECT md5('sku'||g)::uuid, CASE WHEN g%2=0 THEN '10000000-0000-4000-8000-000000000001'::uuid ELSE '10000000-0000-4000-8000-000000000002'::uuid END, 1 FROM generate_series(1,250) g;
INSERT INTO commerce_listings(id, sku_id, location_id, published_at)
 SELECT md5('lst'||g)::uuid, md5('sku'||g)::uuid, s.location_id, now() - (g||' minutes')::interval
 FROM generate_series(1,250) g JOIN inv_stocks s ON s.sku_id=md5('sku'||g)::uuid;
-- 不应入筐：人工 false、标准品、高价自动、零库存
INSERT INTO inv_skus(id, price_tier, fankuang_override) VALUES (md5('x1')::uuid, 10, false);
INSERT INTO inv_skus(id, price_tier, is_custom_price) VALUES (md5('x2')::uuid, 10, false);
INSERT INTO inv_skus(id, price_tier) VALUES (md5('x3')::uuid, 50), (md5('x4')::uuid, 10);
INSERT INTO inv_stocks VALUES (md5('x1')::uuid,'10000000-0000-4000-8000-000000000001',1),(md5('x2')::uuid,'10000000-0000-4000-8000-000000000001',5),
 (md5('x3')::uuid,'10000000-0000-4000-8000-000000000001',1),(md5('x4')::uuid,'10000000-0000-4000-8000-000000000001',0);
INSERT INTO commerce_listings(sku_id, location_id) SELECT id, '10000000-0000-4000-8000-000000000001' FROM inv_skus WHERE id IN (md5('x1')::uuid,md5('x2')::uuid,md5('x3')::uuid,md5('x4')::uuid);
-- 标准赠礼 SKU（不建库存）+ 一个误发布的赠礼 listing
INSERT INTO inv_skus(id, is_custom_price, price_tier, inventory_policy) VALUES ('99999999-0000-4000-8000-000000000001', false, 0, 'unlimited');
INSERT INTO app_settings(key,value) VALUES ('fankuang_gift_sku_id', '{"sku_id":"99999999-0000-4000-8000-000000000001"}');
INSERT INTO commerce_listings(id, sku_id, location_id) VALUES ('99999999-0000-4000-8000-0000000000aa','99999999-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');

DO $$ DECLARE r jsonb; n int; BEGIN
  r := commerce_fankuang_rebuild_round('2026-10-09');
  ASSERT (r->>'basket_count')::int = 3, 'three baskets';
  ASSERT (SELECT count(*) FROM commerce_fankuang_basket_slots WHERE business_date='2026-10-09') = 250, 'only eligible listings';
  ASSERT (SELECT max(cnt) FROM (SELECT count(*) cnt FROM commerce_fankuang_basket_slots WHERE business_date='2026-10-09' GROUP BY basket_no) t) = 100, '100 per basket';
  r := commerce_fankuang_rebuild_round('2026-10-09');
  ASSERT (r->>'created')::boolean = false, 'same-day rebuild is idempotent';
  RAISE NOTICE 'PASS rebuild 100/basket, eligibility, idempotent';
END $$;

DO $$ DECLARE r jsonb; sold uuid; BEGIN
  SELECT listing_id INTO sold FROM commerce_fankuang_basket_slots WHERE business_date='2026-10-09' AND basket_no=1 AND slot_no=1;
  UPDATE commerce_listings SET status='sold' WHERE id=sold;
  INSERT INTO inv_skus(id) VALUES (md5('new1')::uuid);
  INSERT INTO inv_stocks VALUES (md5('new1')::uuid,'10000000-0000-4000-8000-000000000003',1);
  INSERT INTO commerce_listings(id, sku_id, location_id) VALUES (md5('newlst')::uuid, md5('new1')::uuid,'10000000-0000-4000-8000-000000000003');
  r := commerce_fankuang_refill('2026-10-09');
  ASSERT (SELECT listing_id FROM commerce_fankuang_basket_slots WHERE business_date='2026-10-09' AND basket_no=1 AND slot_no=1) = md5('newlst')::uuid, 'gap filled by newest listing';
  ASSERT NOT EXISTS (SELECT 1 FROM commerce_fankuang_basket_slots WHERE listing_id=sold), 'sold listing removed';
  RAISE NOTICE 'PASS refill replaces sold slot with new listing';
END $$;

DO $$ DECLARE s1 jsonb; s2 jsonb; sid uuid; snap uuid[]; BEGIN
  s1 := commerce_fankuang_start_session('c0000000-0000-4000-8000-000000000001','op-session-1','2026-10-09');
  sid := (s1->>'id')::uuid;
  snap := ARRAY(SELECT jsonb_array_elements_text(s1->'listing_ids')::uuid);
  ASSERT cardinality(snap) BETWEEN 1 AND 100, 'snapshot bounded by basket';
  -- 全局补位不改变已冻结快照
  UPDATE commerce_listings SET status='sold' WHERE id=snap[2];
  PERFORM commerce_fankuang_refill('2026-10-09');
  s2 := commerce_fankuang_start_session('c0000000-0000-4000-8000-000000000001','op-session-2','2026-10-09');
  ASSERT (s2->>'id')::uuid = sid, 'active session is returned, not replaced';
  ASSERT s2->'listing_ids' = s1->'listing_ids', 'snapshot frozen';
  ASSERT (commerce_fankuang_start_session('c0000000-0000-4000-8000-000000000001','op-session-1','2026-10-09')->>'id')::uuid = sid, 'client op replay';
  RAISE NOTICE 'PASS session snapshot frozen and replayable';
END $$;

DO $$ DECLARE s jsonb; sid uuid; snap uuid[]; f1 jsonb; f2 jsonb; f3 jsonb; ok boolean; BEGIN
  s := commerce_fankuang_current_session('c0000000-0000-4000-8000-000000000001');
  sid := (s->>'id')::uuid; snap := ARRAY(SELECT jsonb_array_elements_text(s->'listing_ids')::uuid);
  -- 强制中奖以确定性验证记账
  CREATE OR REPLACE FUNCTION commerce_fankuang_draw_wins() RETURNS boolean LANGUAGE sql VOLATILE AS $f$ SELECT true $f$;
  f1 := commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, snap[1], 'op-flip-0001');
  ASSERT (f1->>'counted')::boolean AND (f1->>'won')::boolean AND f1->>'entitlement_id' IS NOT NULL, 'valid flip counted and won';
  f2 := commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, snap[1], 'op-flip-0001');
  ASSERT (f2->>'replayed')::boolean AND f2->>'entitlement_id' = f1->>'entitlement_id', 'same op replays';
  f3 := commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, snap[1], 'op-flip-0002');
  ASSERT NOT (f3->>'counted')::boolean AND (f3->>'duplicate')::boolean, 'flipping back to the same listing does not redraw';
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE customer_id='c0000000-0000-4000-8000-000000000001') = 1, 'one entitlement';
  f3 := commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, snap[2], 'op-flip-0003');
  ASSERT NOT (f3->>'counted')::boolean AND f3->>'reason' = 'listing_unavailable', 'sold listing not a valid flip';
  BEGIN PERFORM commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, snap[3], 'op-flip-0001'); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%client op conflict%'; END;
  ASSERT ok, 'op reuse with other listing rejected';
  BEGIN PERFORM commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, '99999999-0000-4000-8000-0000000000aa', 'op-flip-0009'); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%listing not in session%'; END;
  ASSERT ok, 'listing outside snapshot rejected';
  BEGIN PERFORM commerce_fankuang_flip('c0000000-0000-4000-8000-000000000002', sid, snap[3], 'op-flip-0010'); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%session not found%'; END;
  ASSERT ok, 'other customer cannot use session';
  -- 再赢一次以便后续下单测试有 2 个资格
  PERFORM commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, snap[3], 'op-flip-0004');
  CREATE OR REPLACE FUNCTION commerce_fankuang_draw_wins() RETURNS boolean LANGUAGE sql VOLATILE AS $f$ SELECT random() < public.commerce_fankuang_gift_probability() $f$;
  RAISE NOTICE 'PASS flip idempotency, no redraw, validity and ownership';
END $$;

DO $$ DECLARE wins int := 0; i int; BEGIN
  FOR i IN 1..40000 LOOP IF commerce_fankuang_draw_wins() THEN wins := wins + 1; END IF; END LOOP;
  ASSERT wins BETWEEN 280 AND 520, format('about 1%% (got %s/40000)', wins);
  RAISE NOTICE 'PASS draw probability ~1%%';
END $$;

-- 下单：失败不扣、超额拒绝、原子预占、幂等、取消一次性释放、付款消耗
DO $$ DECLARE base jsonb; r jsonb; ok boolean; ids uuid[]; a uuid := md5('lst2')::uuid; b uuid := md5('lst1')::uuid; BEGIN
  SELECT array_agg(id ORDER BY created_at) INTO ids FROM commerce_fankuang_gift_entitlements WHERE customer_id='c0000000-0000-4000-8000-000000000001';
  ASSERT cardinality(ids) = 2, 'two entitlements ready';
  base := jsonb_build_object('p_customer_id','c0000000-0000-4000-8000-000000000001','p_recipient_name','张三','p_recipient_phone','13800000000',
    'p_shipping_address','{}'::jsonb,'p_courier_provider','sf','p_courier_service_code','SF','p_courier_service_name',NULL,'p_shipping_fee',0,
    'p_quote_snapshot',NULL,'p_customer_note',NULL,
    'p_merchant_id','m','p_app_id','a','p_owned_location_ids', jsonb_build_array('10000000-0000-4000-8000-000000000001'));
  -- 付费 1 件、要 2 个赠礼 → 拒绝且订单回滚
  BEGIN r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_order',
      base || jsonb_build_object('p_idempotency_key','k1','p_items', jsonb_build_array(jsonb_build_object('listing_id',a,'quantity',1))), ids, 2); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift exceeds paid items%'; END;
  ASSERT ok AND NOT EXISTS (SELECT 1 FROM commerce_orders WHERE idempotency_key='k1'), 'over-claim rejected, order rolled back';
  -- 下单失败不扣资格
  BEGIN r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_order',
      base || jsonb_build_object('p_idempotency_key','k0','p_recipient_name','FAIL','p_items', jsonb_build_array(jsonb_build_object('listing_id',a,'quantity',2))), ids, 2); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  ASSERT ok AND (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE status='available') = 2, 'failed order keeps entitlements';
  -- 赠礼 SKU 不能直接购买
  BEGIN r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_order',
      base || jsonb_build_object('p_idempotency_key','kg','p_items', jsonb_build_array(jsonb_build_object('listing_id','99999999-0000-4000-8000-0000000000aa','quantity',1))), NULL, 0); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift sku not purchasable%'; END;
  ASSERT ok, 'gift sku not purchasable';
  -- 跨店 2 件付费（含同 SKU 多件语义） + 2 赠礼
  r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_order',
      base || jsonb_build_object('p_idempotency_key','k2','p_items', jsonb_build_array(jsonb_build_object('listing_id',a,'quantity',1), jsonb_build_object('listing_id',b,'quantity',1))), ids, 2);
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE status='reserved' AND order_id=(r->>'id')::uuid) = 2, 'reserved atomically';
  ASSERT (SELECT sum(quantity) FROM commerce_order_gift_allocations WHERE order_id=(r->>'id')::uuid) = 2, 'allocated 2';
  ASSERT NOT EXISTS (SELECT 1 FROM commerce_order_gift_allocations g WHERE g.order_id=(r->>'id')::uuid
    AND g.location_id NOT IN (SELECT location_id FROM commerce_order_items WHERE order_id=(r->>'id')::uuid)), 'only order stores';
  ASSERT (r->'gift_allocations') IS NOT NULL, 'response carries allocations';
  -- 同键重试不重复
  r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_order',
      base || jsonb_build_object('p_idempotency_key','k2','p_items', jsonb_build_array(jsonb_build_object('listing_id',a,'quantity',1), jsonb_build_object('listing_id',b,'quantity',1))), ids, 2);
  ASSERT (SELECT sum(quantity) FROM commerce_order_gift_allocations WHERE order_id=(r->>'id')::uuid) = 2, 'replay no duplicate';
  BEGIN PERFORM commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_order',
      base || jsonb_build_object('p_idempotency_key','k2','p_items', jsonb_build_array(jsonb_build_object('listing_id',a,'quantity',1))), ids[1:1], 1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift idempotency conflict%'; END;
  ASSERT ok, 'same key different gifts rejected';
  -- 赠礼不算付费件数：直接插入赠礼行被拒
  BEGIN INSERT INTO commerce_order_items(order_id, sku_id, location_id, quantity) VALUES ((r->>'id')::uuid,'99999999-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1); ok := false;
  EXCEPTION WHEN others THEN ok := SQLERRM LIKE '%gift sku not purchasable%'; END;
  ASSERT ok, 'gift sku cannot be an order item';
  -- 取消一次性释放
  UPDATE commerce_orders SET order_status='cancelled' WHERE id=(r->>'id')::uuid;
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE status='available' AND release_count=1) = 2, 'released once';
  UPDATE commerce_orders SET order_status='closed' WHERE id=(r->>'id')::uuid;
  ASSERT (SELECT max(release_count) FROM commerce_fankuang_gift_entitlements) = 1, 'no double release';
  -- 自提下单 + 付款消耗
  r := commerce_create_order_with_fankuang_gifts('commerce_create_ordinary_pickup_order',
      jsonb_build_object('p_customer_id','c0000000-0000-4000-8000-000000000001','p_idempotency_key','k3','p_recipient_name','张三','p_recipient_phone','13800000000',
        'p_quote_snapshot',NULL,'p_customer_note',NULL,'p_owned_location_ids',NULL,'p_merchant_id','m','p_app_id','a','p_items', jsonb_build_array(jsonb_build_object('listing_id',a,'quantity',3))), NULL, 1);
  ASSERT (SELECT count(*) FROM commerce_fankuang_gift_entitlements WHERE order_id=(r->>'id')::uuid) = 1, 'count-only pick';
  ASSERT (SELECT location_id FROM commerce_order_gift_allocations WHERE order_id=(r->>'id')::uuid) = '10000000-0000-4000-8000-000000000001', 'single store order gift from that store';
  UPDATE commerce_orders SET payment_status='paid', paid_at=now() WHERE id=(r->>'id')::uuid;
  ASSERT (SELECT status FROM commerce_fankuang_gift_entitlements WHERE order_id=(r->>'id')::uuid) = 'consumed', 'consumed on pay';
  UPDATE commerce_orders SET order_status='cancelled' WHERE id=(r->>'id')::uuid;
  ASSERT (SELECT status FROM commerce_fankuang_gift_entitlements WHERE order_id=(r->>'id')::uuid) = 'consumed', 'paid gifts not auto released';
  r := commerce_fankuang_gift_balance('c0000000-0000-4000-8000-000000000001');
  ASSERT (r->>'available')::int = 1 AND (r->>'consumed')::int = 1, 'balance';
  RAISE NOTICE 'PASS gift order atomic reserve, limits, idempotency, cancel release, pay consume';
END $$;

DO $$ DECLARE s jsonb; sid uuid; l uuid; i int := 0; BEGIN
  s := commerce_fankuang_current_session('c0000000-0000-4000-8000-000000000001'); sid := (s->>'id')::uuid;
  FOR l IN SELECT jsonb_array_elements_text(s->'listing_ids')::uuid LOOP
    i := i + 1; PERFORM commerce_fankuang_flip('c0000000-0000-4000-8000-000000000001', sid, l, 'op-done-'||lpad(i::text,6,'0'));
  END LOOP;
  ASSERT (SELECT status FROM commerce_fankuang_sessions WHERE id=sid) = 'completed', 'session completes after all flipped/unavailable';
  ASSERT (commerce_fankuang_start_session('c0000000-0000-4000-8000-000000000001','op-session-3','2026-10-09')->>'id')::uuid <> sid, 'new session after completion';
  ASSERT has_function_privilege('authenticated','commerce_fankuang_flip(uuid,uuid,uuid,text)','EXECUTE') = false, 'no client execute';
  ASSERT has_table_privilege('anon','commerce_fankuang_gift_entitlements','SELECT') = false, 'no anon read';
  RAISE NOTICE 'PASS completion and privileges';
END $$;
