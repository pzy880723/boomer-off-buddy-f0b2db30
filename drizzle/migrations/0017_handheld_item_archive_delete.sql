-- Mobile deletion archives identity/history and posts compensating inventory movements.
-- Physical deletion and its stricter RLS policy are intentionally unchanged.
CREATE OR REPLACE FUNCTION public.handheld_item_delete(
  p_device_id uuid, p_user_id uuid, p_client_op_id text, p_location_id uuid,
  p_sku_id uuid, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_replay jsonb; v_actor jsonb; v_sku public.inv_skus; v_after public.inv_skus;
  v_op_id uuid := gen_random_uuid(); v_resp jsonb; v_stock record;
  v_stocks jsonb; v_listings jsonb; v_removed integer := 0; v_queued integer := 0;
BEGIN
  v_actor := public.handheld_item_actor(p_user_id, p_location_id);
  IF NOT (v_actor->>'hq')::boolean THEN
    PERFORM public.handheld_item_fail('delete_forbidden', '仅总部管理员可以删除商品');
  END IF;
  v_replay := public.handheld_item_replay(p_device_id, p_client_op_id, 'delete', p_user_id,
                                          p_location_id, p_sku_id, p_fingerprint);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  -- Match checkout's listing-before-stock locking; recheck blockers after the locks.
  PERFORM id FROM public.commerce_listings WHERE sku_id=p_sku_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=p_sku_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.handheld_item_fail('not_found', '商品不存在'); END IF;
  IF v_sku.status='archived' THEN
    RETURN jsonb_build_object('deleted_sku_id',p_sku_id,'replayed',true,'stock_removed',0);
  END IF;
  PERFORM location_id FROM public.inv_stocks WHERE sku_id=p_sku_id ORDER BY location_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.inventory_reservations r
              WHERE r.status='active' AND (r.sku_id=p_sku_id OR EXISTS (
                SELECT 1 FROM public.inventory_reservation_lines l
                 WHERE l.reservation_id=r.id AND l.stock_sku_id=p_sku_id)))
     OR EXISTS (SELECT 1 FROM public.commerce_order_items i
                  JOIN public.commerce_orders o ON o.id=i.order_id
                 WHERE i.sku_id=p_sku_id AND o.order_status NOT IN ('completed','cancelled','closed')
                   AND o.payment_status NOT IN ('refunded','payment_failed')) THEN
    PERFORM public.handheld_item_fail('delete_blocked', '商品有未完成的订单或库存预留，请先完成或取消订单后删除');
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_transfers t
              WHERE t.status IN ('draft','in_transit') AND
                (t.from_sku_id=p_sku_id OR t.to_sku_id=p_sku_id OR EXISTS (
                  SELECT 1 FROM public.stock_transfer_lines l WHERE l.transfer_id=t.id AND l.sku_id=p_sku_id))) THEN
    PERFORM public.handheld_item_fail('delete_blocked', '商品有未完成的调拨，请先签收或取消调拨后删除');
  END IF;
  IF EXISTS (SELECT 1 FROM public.inv_skus s WHERE s.status='active' AND s.id<>p_sku_id
              AND s.bundle_items @> jsonb_build_array(jsonb_build_object('sku_id',p_sku_id))) THEN
    PERFORM public.handheld_item_fail('delete_blocked', '商品仍用于在售组包，请先移除组包中的该商品');
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.location_id),'[]') INTO v_stocks
    FROM public.inv_stocks s WHERE sku_id=p_sku_id;
  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]') INTO v_listings
    FROM public.commerce_listings l WHERE sku_id=p_sku_id;
  -- Archive first so an inventory callback cannot publish a fresh listing.
  UPDATE public.inv_skus SET status='archived',is_display=false,updated_at=now() WHERE id=p_sku_id;
  FOR v_stock IN SELECT * FROM public.inv_stocks WHERE sku_id=p_sku_id AND qty<>0 ORDER BY location_id LOOP
    IF v_sku.inventory_policy='unlimited' THEN
      UPDATE public.inv_stocks SET qty=0,updated_at=now()
       WHERE sku_id=p_sku_id AND location_id=v_stock.location_id;
      INSERT INTO public.inv_stock_movements(sku_id,location_id,delta,balance_after,ref_type,ref_id,note,created_by)
      VALUES(p_sku_id,v_stock.location_id,-v_stock.qty,0,'manual_adjust',v_op_id,'管理员删除商品清退库存',p_user_id);
    ELSE
      PERFORM public.inv_apply_movement(p_sku_id,v_stock.location_id,-v_stock.qty,
        'manual_adjust',v_op_id,NULL,'管理员删除商品清退库存');
      UPDATE public.inv_stock_movements SET created_by=p_user_id
       WHERE sku_id=p_sku_id AND ref_id=v_op_id AND location_id=v_stock.location_id;
    END IF;
    v_removed := v_removed + v_stock.qty;
  END LOOP;
  UPDATE public.inv_skus SET stock_qty=0,updated_at=now() WHERE id=p_sku_id RETURNING * INTO v_after;
  UPDATE public.commerce_listings SET status='archived',updated_at=now() WHERE sku_id=p_sku_id;
  UPDATE public.handheld_youzan_release_outbox SET status='cancelled',last_error='商品已删除',updated_at=now()
   WHERE sku_id=p_sku_id AND status IN ('pending','failed');
  UPDATE public.handheld_youzan_item_sync_outbox SET status='cancelled',last_error='商品已删除',updated_at=now()
   WHERE sku_id=p_sku_id AND status IN ('pending','failed');
  UPDATE public.youzan_stock_sync_queue SET status='done',target_stock=0,target_is_display=false,
    reason='superseded_by_item_delete',last_error=NULL,updated_at=now()
   WHERE sku_id=p_sku_id AND status IN ('pending','failed');

  -- Queue only already linked branches, never create new cross-store listings.
  INSERT INTO public.youzan_stock_sync_queue(sku_id,shop_id,location_id,target_stock,reason,status,action,target_is_display)
  SELECT p_sku_id,l.shop_id,NULL,0,'handheld_item_deleted','pending','push_stock',false
    FROM public.sku_youzan_links l JOIN public.youzan_shops s ON s.id=l.shop_id
   WHERE l.sku_id=p_sku_id AND s.role='branch' AND l.yz_item_id>0
  ON CONFLICT (sku_id,shop_id) WHERE status IN ('pending','failed')
  DO UPDATE SET target_stock=0,action='push_stock',target_is_display=false,reason='handheld_item_deleted',
    status='pending',attempts=0,next_run_at=now(),last_error=NULL,updated_at=now();
  GET DIAGNOSTICS v_queued = ROW_COUNT;

  v_resp := jsonb_build_object('deleted_sku_id',p_sku_id,'replayed',false,
                               'stock_removed',v_removed,'youzan_sync_queued',v_queued);
  INSERT INTO public.handheld_item_ops(id,device_id,client_op_id,op_type,user_id,location_id,sku_id,fingerprint,response)
  VALUES(v_op_id,p_device_id,p_client_op_id,'delete',p_user_id,p_location_id,p_sku_id,p_fingerprint,v_resp);
  INSERT INTO public.handheld_item_audit(op_id,sku_id,action,actor_user_id,device_id,location_id,
                                       before_snapshot,after_snapshot,changed_fields)
  VALUES(v_op_id,p_sku_id,'delete',p_user_id,p_device_id,p_location_id,
         to_jsonb(v_sku)||jsonb_build_object('stocks',v_stocks,'listings',v_listings),
         to_jsonb(v_after),ARRAY['status','is_display','stock_qty','stocks','listings']);
  RETURN v_resp;
END;
$$;
REVOKE ALL ON FUNCTION public.handheld_item_delete(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_item_delete(uuid,uuid,text,uuid,uuid,text) TO service_role;
