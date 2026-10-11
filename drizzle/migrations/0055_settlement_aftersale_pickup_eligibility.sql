-- 0055：清算阻断补实际售后表活跃状态；complete_pick 阻断全部清算原因；顾客自提服务端 per-fulfillment 资格。
-- 回滚：从 0054 重放 commerce_order_settlement_block 与 fulfillment_complete_pick 定义，
--   再 DROP FUNCTION public.commerce_storefront_pickup_eligibility(uuid[]);
CREATE OR REPLACE FUNCTION public.commerce_order_settlement_block(p_order_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN o.id IS NULL THEN 'not_found'
    WHEN o.order_status IN ('cancelled','closed') THEN 'cancelled'
    WHEN o.payment_status IN ('refunded','refund_pending') THEN 'refund_blocked'
    WHEN o.order_status = 'after_sale' THEN 'after_sale_blocked'
    WHEN o.payment_status NOT IN ('paid','partially_refunded') THEN 'unpaid'
    WHEN EXISTS (SELECT 1 FROM public.commerce_payments p WHERE p.order_id = o.id AND p.status = 'refunded') THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status IN ('pending','processing')) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refund_intents i WHERE i.order_id = o.id AND i.state <> 'succeeded') THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refund_intents i WHERE i.order_id = o.id AND i.state = 'succeeded'
                  AND NOT public.commerce_shortage_refund_cleared(i.shortage_id)) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.fulfillment_shortages s WHERE s.order_id = o.id AND s.status <> 'withdrawn'
                  AND (s.refund_state IN ('manual_review','failed','processing','queued','refund_pending')
                       OR (s.status = 'customer_accepted' AND NOT public.commerce_shortage_refund_cleared(s.id)))) THEN 'refund_blocked'
    WHEN EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status = 'succeeded'
                  AND NOT EXISTS (SELECT 1 FROM public.commerce_refund_intents i WHERE i.refund_id = r.id AND i.state = 'succeeded'
                                   AND public.commerce_shortage_refund_cleared(i.shortage_id))) THEN 'refund_blocked'
    WHEN o.payment_status = 'partially_refunded'
         AND NOT EXISTS (SELECT 1 FROM public.commerce_refunds r WHERE r.order_id = o.id AND r.status = 'succeeded') THEN 'refund_blocked'
    -- 实际售后表：任何活跃售后（含父订单文字仍 paid/processing 的 refund_only/return_refund）阻断交付；
    -- 已结清缺货售后由退款链写为 refunded（终态），不阻断剩余商品。
    WHEN EXISTS (SELECT 1 FROM public.commerce_after_sales a WHERE a.order_id = o.id
                  AND a.status IN ('requested','store_reviewing','approved','customer_shipping','store_received','inspecting','refund_pending')) THEN 'after_sale_blocked'
    ELSE NULL END
  FROM (SELECT p_order_id AS id) x LEFT JOIN public.commerce_orders o ON o.id = x.id
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_complete_pick(p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid)
 RETURNS fulfillments LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.fulfillments;
  v_order_status text;
  v_block text;
BEGIN
  SELECT * INTO v_row FROM public.fulfillments WHERE id = p_fulfillment_id AND location_id = p_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  SELECT order_status INTO v_order_status FROM public.commerce_orders WHERE id = v_row.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking: order_missing'; END IF;
  SELECT * INTO v_row FROM public.fulfillments WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  IF v_row.status <> 'picking'
     OR (v_row.claimed_device_id IS NOT NULL
         AND v_row.claimed_device_id IS DISTINCT FROM p_device_id) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking';
  END IF;
  IF v_order_status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: order_cancelled';
  END IF;

  PERFORM fi.id FROM public.fulfillment_items fi
   WHERE fi.fulfillment_id = p_fulfillment_id ORDER BY fi.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking: items_empty'; END IF;
  PERFORM s.id FROM public.fulfillment_shortages s
   WHERE s.fulfillment_id = p_fulfillment_id ORDER BY s.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shortages
     WHERE fulfillment_id = p_fulfillment_id AND status = 'pending_customer'
  ) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: shortage_pending_customer_confirmation';
  END IF;
  v_block := public.commerce_order_settlement_block(v_row.order_id);
  -- 所有清算阻断原因（unpaid / after_sale_blocked / refund_blocked / cancelled / not_found）一律拒绝；
  -- refund_blocked 保持旧文案 refund_pending 以兼容既有客户端错误映射。
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: %', CASE v_block WHEN 'refund_blocked' THEN 'refund_pending' ELSE v_block END;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.fulfillment_items fi
     WHERE fi.fulfillment_id = p_fulfillment_id
       AND fi.picked_qty < greatest(fi.expected_qty - public.commerce_item_cleared_shortage_qty(fi.id), 0)
  ) THEN
    RAISE EXCEPTION 'fulfillment still has unpicked items';
  END IF;

  UPDATE public.fulfillments SET status = 'picked', picked_at = now(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

-- 顾客自提资格：与手持 mark_ready/redeem 同一 commerce_pickup_block_reason 事实；block_reason NULL = 可显示凭证。
CREATE OR REPLACE FUNCTION public.commerce_storefront_pickup_eligibility(p_order_ids uuid[])
RETURNS TABLE(order_id uuid, fulfillment_id uuid, block_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.order_id, f.id, public.commerce_pickup_block_reason(f.order_id, f.id)
    FROM public.fulfillments f
   WHERE f.order_id = ANY (coalesce(p_order_ids, '{}'::uuid[]))
   ORDER BY f.order_id, f.id
   LIMIT 500
$$;
REVOKE ALL ON FUNCTION public.commerce_storefront_pickup_eligibility(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_storefront_pickup_eligibility(uuid[]) TO service_role;