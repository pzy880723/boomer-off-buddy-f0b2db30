-- 0013 重复撤销流水使用现有允许的 ref_type manual_adjust（note 前缀 duplicate_listing_revoke 可检索），不放宽库存流水约束。
CREATE OR REPLACE FUNCTION public.inv_revoke_duplicate_sku(
  p_duplicate_sku_id uuid, p_kept_sku_id uuid, p_location_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.inv_sku_duplicate_revocations;
  v_before jsonb; v_after jsonb; v_qty integer; v_other integer;
BEGIN
  IF p_duplicate_sku_id = p_kept_sku_id THEN RAISE EXCEPTION '保留商品与重复商品不能相同'; END IF;
  PERFORM 1 FROM public.inv_skus WHERE id IN (p_duplicate_sku_id, p_kept_sku_id) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM public.inv_skus WHERE id IN (p_duplicate_sku_id, p_kept_sku_id)) <> 2 THEN
    RAISE EXCEPTION '商品不存在';
  END IF;
  PERFORM 1 FROM public.inv_stocks WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id) ORDER BY sku_id, location_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.inv_sku_duplicate_revocations WHERE duplicate_sku_id = p_duplicate_sku_id;
  IF FOUND THEN
    RETURN jsonb_build_object('replayed', true, 'revocation_id', v_existing.id, 'after', v_existing.after_snapshot);
  END IF;

  IF EXISTS (SELECT 1 FROM public.commerce_order_items WHERE sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.inventory_reservations WHERE sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.inventory_reservation_lines WHERE stock_sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.inventory_sale_events WHERE sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.stock_transfer_lines WHERE sku_id = p_duplicate_sku_id) THEN
    RAISE EXCEPTION '重复商品已有订单、预占、销售或调拨记录，不能撤销';
  END IF;
  SELECT qty INTO v_qty FROM public.inv_stocks WHERE sku_id = p_duplicate_sku_id AND location_id = p_location_id;
  SELECT count(*) INTO v_other FROM public.inv_stocks
   WHERE sku_id = p_duplicate_sku_id AND location_id <> p_location_id AND qty <> 0;
  IF v_qty IS DISTINCT FROM 1 OR v_other > 0 THEN
    RAISE EXCEPTION '重复商品库存不是仅目标库位 1 件，停止撤销';
  END IF;

  v_before := jsonb_build_object(
    'duplicate', (SELECT to_jsonb(s) FROM public.inv_skus s WHERE id = p_duplicate_sku_id),
    'kept', (SELECT to_jsonb(s) FROM public.inv_skus s WHERE id = p_kept_sku_id),
    'stocks', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM public.inv_stocks x WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)),
    'listings', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM public.commerce_listings x WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)),
    'youzan_links', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM public.sku_youzan_links x WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)));

  INSERT INTO public.inv_sku_duplicate_revocations (duplicate_sku_id, kept_sku_id, location_id, reason, before_snapshot)
  VALUES (p_duplicate_sku_id, p_kept_sku_id, p_location_id, p_reason, v_before);

  PERFORM public.inv_apply_movement(p_duplicate_sku_id, p_location_id, -1, 'manual_adjust',
    p_duplicate_sku_id, NULL, left('duplicate_listing_revoke 重复上架撤销，保留 ' || p_kept_sku_id::text || '：' || p_reason, 500));
  UPDATE public.inv_skus SET status = 'archived', is_display = false, updated_at = now()
   WHERE id = p_duplicate_sku_id;
  UPDATE public.commerce_listings SET status = 'archived', updated_at = now()
   WHERE sku_id = p_duplicate_sku_id AND status IN ('draft','published','hidden');
  UPDATE public.handheld_youzan_release_outbox SET status = 'cancelled', updated_at = now()
   WHERE sku_id = p_duplicate_sku_id AND status IN ('pending','failed');

  v_after := jsonb_build_object(
    'duplicate', (SELECT jsonb_build_object('status', status, 'is_display', is_display, 'stock_qty', stock_qty) FROM public.inv_skus WHERE id = p_duplicate_sku_id),
    'stocks', (SELECT coalesce(jsonb_agg(jsonb_build_object('sku_id', sku_id, 'location_id', location_id, 'qty', qty)), '[]') FROM public.inv_stocks WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)),
    'listings', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'sku_id', sku_id, 'status', status)), '[]') FROM public.commerce_listings WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)));
  UPDATE public.inv_sku_duplicate_revocations SET after_snapshot = v_after WHERE duplicate_sku_id = p_duplicate_sku_id;
  RETURN jsonb_build_object('replayed', false, 'after', v_after);
END;
$$;
REVOKE ALL ON FUNCTION public.inv_revoke_duplicate_sku(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_revoke_duplicate_sku(uuid,uuid,uuid,text) TO service_role;
