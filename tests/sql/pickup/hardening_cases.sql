\set ON_ERROR_STOP 1
DO $$ DECLARE o uuid; r jsonb; tok text; fid uuid; BEGIN
  -- H1 停用门店：员工即使有权限也不能核销/备货
  UPDATE inv_locations SET is_active=false WHERE id='a0000000-0000-4000-8000-000000000002';
  ASSERT NOT commerce_pickup_actor_can('b0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-000000000002'), 'inactive shop must deny staff';
  ASSERT NOT commerce_pickup_actor_can('b0000000-0000-4000-8000-00000000000c','a0000000-0000-4000-8000-000000000002'), 'inactive shop must deny HQ';
  UPDATE inv_locations SET is_active=true WHERE id='a0000000-0000-4000-8000-000000000002';
  RAISE NOTICE 'PASS inactive shop denies pickup actors';
  -- H2 售后中订单：无退款/缺货记录也要阻断
  INSERT INTO commerce_orders(fulfillment_method) VALUES ('pickup') RETURNING id INTO o;
  PERFORM test_mark_paid(o, ARRAY['a0000000-0000-4000-8000-000000000001']::uuid[]);
  SELECT qr_token, fulfillment_id INTO tok, fid FROM commerce_pickup_codes WHERE order_id=o;
  PERFORM commerce_pickup_mark_ready('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001',fid,'h2-ready-1');
  UPDATE commerce_orders SET order_status='after_sale' WHERE id=o;
  ASSERT commerce_pickup_block_reason(o, fid)='after_sale_blocked', 'block reason after_sale';
  r := commerce_pickup_redeem('b0000000-0000-4000-8000-00000000000a','a0000000-0000-4000-8000-000000000001','BOOMER_PICKUP:'||tok,NULL,'h2-redeem-1');
  ASSERT r->>'result'='after_sale_blocked', 'after_sale redeem: '||r;
  RAISE NOTICE 'PASS after_sale order blocks redeem without refund/shortage rows';
END $$;
