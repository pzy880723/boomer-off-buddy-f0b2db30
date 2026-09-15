-- 隔离库测试夹具：只在本地 PG 的 shortage_test 库使用，绝不指向生产库。
CREATE OR REPLACE FUNCTION public.t_mk_order(
  p_tag text,
  p_item_count integer,
  p_unit numeric,
  p_shipping numeric,
  p_paid numeric,
  p_payment_status text DEFAULT 'succeeded'
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_customer uuid := gen_random_uuid();
  v_order uuid := gen_random_uuid();
  v_loc uuid := gen_random_uuid();
  v_ful uuid := gen_random_uuid();
  v_payment uuid := gen_random_uuid();
  v_items uuid[] := '{}';
  v_fitems uuid[] := '{}';
  v_item uuid;
  v_fitem uuid;
  i integer;
BEGIN
  INSERT INTO public.commerce_customers (id, external_subject) VALUES (v_customer, 'test:' || p_tag);
  INSERT INTO public.commerce_orders (id, order_no, customer_id, payment_status, shipping_fee, total_amount,
                                      idempotency_key, reservation_expires_at)
    VALUES (v_order, 'T-' || p_tag, v_customer, 'paid', p_shipping, p_paid, 'idem-' || p_tag, now() + interval '1 day');
  INSERT INTO public.commerce_payments (id, order_id, provider, amount, status, idempotency_key, paid_at)
    VALUES (v_payment, v_order, 'wechat', p_paid, p_payment_status, 'pay-' || p_tag, now());
  INSERT INTO public.fulfillments (id, order_id, location_id, status)
    VALUES (v_ful, v_order, v_loc, 'picking');

  FOR i IN 1..p_item_count LOOP
    v_item := gen_random_uuid();
    v_fitem := gen_random_uuid();
    INSERT INTO public.commerce_order_items (id, order_id, sku_id, location_id, title_snapshot,
                                             unit_price, line_total, quantity)
      VALUES (v_item, v_order, gen_random_uuid(), v_loc, 'item ' || i, p_unit, p_unit, 1);
    INSERT INTO public.fulfillment_items (id, fulfillment_id, order_item_id, sku_id, expected_qty, picked_qty)
      VALUES (v_fitem, v_ful, v_item, gen_random_uuid(), 1, 0);
    v_items := v_items || v_item;
    v_fitems := v_fitems || v_fitem;
  END LOOP;

  RETURN jsonb_build_object('customer_id', v_customer, 'order_id', v_order, 'location_id', v_loc,
                            'fulfillment_id', v_ful, 'payment_id', v_payment,
                            'item_ids', to_jsonb(v_items), 'fulfillment_item_ids', to_jsonb(v_fitems));
END;
$$;

-- 直接落一条待客户确认的缺货（模拟服务端已给出的报价快照）
CREATE OR REPLACE FUNCTION public.t_mk_shortage(
  p_ctx jsonb,
  p_idx integer,
  p_goods_fen integer,
  p_shipping_fen integer,
  p_version text
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.fulfillment_shortages (
    id, fulfillment_id, fulfillment_item_id, order_id, order_item_id, location_id,
    quantity, reason, status, refund_state, client_op_id,
    quote_version, refund_goods_fen, refund_shipping_fen, refund_total_fen, quote_snapshot
  ) VALUES (
    v_id, (p_ctx->>'fulfillment_id')::uuid,
    ((p_ctx->'fulfillment_item_ids')->>p_idx)::uuid,
    (p_ctx->>'order_id')::uuid,
    ((p_ctx->'item_ids')->>p_idx)::uuid,
    (p_ctx->>'location_id')::uuid,
    1, '缺货', 'pending_customer', 'awaiting_confirmation', 'op-' || v_id,
    p_version, p_goods_fen, p_shipping_fen, p_goods_fen + p_shipping_fen,
    jsonb_build_object('can_confirm', true, 'quote_version', p_version,
                       'refund_goods_fen', p_goods_fen, 'refund_shipping_fen', p_shipping_fen,
                       'refund_total_fen', p_goods_fen + p_shipping_fen)
  );
  RETURN v_id;
END;
$$;
