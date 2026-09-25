-- Run inside BEGIN/ROLLBACK. No real products or committed test data are changed.
DO $test$
DECLARE
  s uuid := gen_random_uuid(); z uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  u uuid; loc uuid; other_loc uuid; listing uuid := gen_random_uuid();
  result jsonb; initial_movements integer;
  v_order_id uuid := gen_random_uuid(); transfer_id uuid := gen_random_uuid(); branch uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SELECT user_id INTO u FROM public.user_roles WHERE role::text='super_admin' LIMIT 1;
  SELECT id INTO loc FROM public.inv_locations WHERE is_active ORDER BY id LIMIT 1;
  SELECT id INTO other_loc FROM public.inv_locations WHERE is_active AND id<>loc ORDER BY id LIMIT 1;
  IF u IS NULL OR loc IS NULL OR other_loc IS NULL THEN RAISE EXCEPTION 'test prerequisites missing'; END IF;
  INSERT INTO public.inv_skus(id,category,price_tier,name,epc,is_custom_price,stock_qty)
  VALUES(s,'toy_building_model',59.9,'ROLLBACK ONLY delete with stock',s::text,true,0),
        (z,'toy_building_model',69.9,'ROLLBACK ONLY delete without stock',z::text,true,0);
  PERFORM public.inv_apply_movement(s,loc,1,'manual_adjust',s,NULL,'rollback test');
  PERFORM public.inv_apply_movement(s,other_loc,2,'manual_adjust',s,NULL,'rollback test');
  INSERT INTO public.commerce_listings(id,sku_id,location_id,title,price)
  VALUES(listing,s,loc,'ROLLBACK ONLY listing',59.9) ON CONFLICT (sku_id,location_id) DO NOTHING;
  SELECT count(*) INTO initial_movements FROM public.inv_stock_movements WHERE sku_id=s;
  SELECT id INTO branch FROM public.youzan_shops WHERE role='branch' ORDER BY id LIMIT 1;
  IF branch IS NULL THEN RAISE EXCEPTION 'branch fixture prerequisite missing'; END IF;
  INSERT INTO public.sku_youzan_links(sku_id,shop_id,yz_item_id) VALUES(s,branch,900000000000000);
  INSERT INTO public.handheld_youzan_release_outbox(sku_id,shop_id,location_id) VALUES(s,branch,loc);
  INSERT INTO public.commerce_orders(id,idempotency_key,reservation_expires_at)
  VALUES(v_order_id,'rollback-delete-'||s::text,now()+interval '15 minutes');
  INSERT INTO public.commerce_order_items(order_id,sku_id,location_id,title_snapshot,unit_price,line_total)
  VALUES(v_order_id,s,loc,'ROLLBACK ONLY order',59.9,59.9);
  BEGIN
    PERFORM public.handheld_item_delete(d,u,'delete-active-order',loc,s,'order');
    RAISE EXCEPTION 'expected unfinished order guard';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'delete_blocked' THEN RAISE; END IF; END;
  UPDATE public.commerce_orders SET order_status='completed',payment_status='paid' WHERE id=v_order_id;
  INSERT INTO public.stock_transfers(id,kind,status,from_sku_id,qty) VALUES(transfer_id,'shop_to_shop','in_transit',s,1);
  BEGIN
    PERFORM public.handheld_item_delete(d,u,'delete-active-transfer',loc,s,'transfer');
    RAISE EXCEPTION 'expected unfinished transfer guard';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'delete_blocked' THEN RAISE; END IF; END;
  UPDATE public.stock_transfers SET status='cancelled' WHERE id=transfer_id;
  BEGIN
    PERFORM public.handheld_item_delete(d,gen_random_uuid(),'delete-denied',loc,s,'deny');
    RAISE EXCEPTION 'expected permission rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT IN ('location_forbidden','delete_forbidden') THEN RAISE; END IF;
  END;
  result := public.handheld_item_delete(d,u,'delete-with-stock',loc,s,'stock');
  IF (result->>'stock_removed')::int IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'wrong removed stock'; END IF;
  IF (result->>'youzan_sync_queued')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'wrong linked shop count'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.youzan_stock_sync_queue WHERE sku_id=s AND shop_id=branch AND status='pending' AND target_stock=0)
     OR EXISTS(SELECT 1 FROM public.youzan_stock_sync_queue WHERE sku_id=s AND shop_id<>branch AND status='pending') THEN
    RAISE EXCEPTION 'channel archive missing or crossed shops'; END IF;
  IF EXISTS(SELECT 1 FROM public.handheld_youzan_release_outbox WHERE sku_id=s AND status<>'cancelled') THEN
    RAISE EXCEPTION 'stale listing job survives'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.commerce_order_items WHERE sku_id=s AND order_id=v_order_id) THEN
    RAISE EXCEPTION 'historical order lost'; END IF;
  IF (SELECT status<>'archived' OR is_display OR stock_qty<>0 FROM public.inv_skus WHERE id=s)
     OR EXISTS(SELECT 1 FROM public.inv_stocks WHERE sku_id=s AND qty<>0) THEN
    RAISE EXCEPTION 'product or stock not archived'; END IF;
  IF EXISTS(SELECT 1 FROM public.commerce_listings WHERE sku_id=s AND status<>'archived') THEN
    RAISE EXCEPTION 'commerce still visible'; END IF;
  IF (SELECT count(*) FROM public.inv_stock_movements WHERE sku_id=s)<>initial_movements+2 THEN
    RAISE EXCEPTION 'missing stock audit'; END IF;
  IF (SELECT count(*) FROM public.handheld_item_audit WHERE sku_id=s AND after_snapshot IS NOT NULL)<>1 THEN
    RAISE EXCEPTION 'missing deletion audit'; END IF;
  result := public.handheld_item_delete(d,u,'delete-with-stock',loc,s,'stock');
  IF NOT (result->>'replayed')::boolean THEN RAISE EXCEPTION 'retry not idempotent'; END IF;
  PERFORM public.handheld_item_delete(d,u,'delete-new-retry',loc,s,'retry');
  IF (SELECT count(*) FROM public.inv_stock_movements WHERE sku_id=s)<>initial_movements+2 THEN
    RAISE EXCEPTION 'duplicate stock removal'; END IF;
  PERFORM public.handheld_item_delete(d,u,'delete-zero-stock',loc,z,'zero');
  IF (SELECT status FROM public.inv_skus WHERE id=z)<>'archived' THEN RAISE EXCEPTION 'zero stock delete failed'; END IF;
  IF has_function_privilege('anon','public.handheld_item_delete(uuid,uuid,text,uuid,uuid,text)','execute')
     OR has_function_privilege('authenticated','public.handheld_item_delete(uuid,uuid,text,uuid,uuid,text)','execute') THEN
    RAISE EXCEPTION 'delete RPC must be service only'; END IF;
END;
$test$;
