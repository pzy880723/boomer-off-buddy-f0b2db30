-- 跨店闪送到付：允许同一订单跨门店选择 flash，各门店分组分别履约、配送费各自到付；
-- 平台运费恒 0，不生成统一运费，不调货。每组门店归属校验在 commerce_create_ordinary_flash_order 内逐 listing 执行（不变）。
CREATE OR REPLACE FUNCTION public.commerce_quote_checkout_v2(p_customer_id uuid, p_items jsonb, p_coupon_id uuid, p_fulfillment_method text DEFAULT 'express')
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v jsonb; v_groups jsonb;
BEGIN
  IF p_fulfillment_method IS NULL OR p_fulfillment_method NOT IN ('express','pickup','flash') THEN
    RAISE EXCEPTION 'invalid fulfillment method';
  END IF;
  v := public.commerce_quote_checkout(p_customer_id, p_items, p_coupon_id);
  IF p_fulfillment_method = 'express' THEN RETURN v; END IF;
  SELECT jsonb_agg(g || jsonb_build_object('shipping_fee_fen', 0, 'remaining_fen', 0) ORDER BY g->>'location_id')
    INTO v_groups FROM jsonb_array_elements(v->'groups') g;
  IF p_fulfillment_method = 'pickup' THEN
    RETURN v || jsonb_build_object('version', 'pickup_v1', 'fulfillment_method', 'pickup', 'groups', v_groups,
      'shipping_fee_fen', 0, 'cross_store_free', false, 'cross_store_remaining_fen', 0,
      'total_fen', (v->>'subtotal_fen')::bigint - coalesce((v->>'discount_fen')::bigint, 0));
  END IF;
  RETURN v || jsonb_build_object('version', 'flash_cod_v1', 'fulfillment_method', 'flash', 'groups', v_groups,
    'shipping_fee_fen', 0, 'cross_store_free', false, 'cross_store_remaining_fen', 0,
    'delivery_fee_payment', 'cod',
    'total_fen', (v->>'subtotal_fen')::bigint - coalesce((v->>'discount_fen')::bigint, 0));
END $$;