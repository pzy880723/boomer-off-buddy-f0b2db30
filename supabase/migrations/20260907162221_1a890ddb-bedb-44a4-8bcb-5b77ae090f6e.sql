CREATE OR REPLACE FUNCTION public.sales_dashboard_report(
  p_location_ids uuid[],
  p_shop_ids uuid[],
  p_include_unassigned boolean,
  p_start timestamptz,
  p_end timestamptz,
  p_trend_start timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH loc AS (
  SELECT COALESCE(p_location_ids, ARRAY[]::uuid[]) AS ids
), shops AS (
  SELECT COALESCE(p_shop_ids, ARRAY[]::uuid[]) AS ids
),
paid_orders AS (
  SELECT o.id, o.source_channel, o.sale_location_id, o.paid_at, o.total_amount
  FROM public.commerce_orders o, loc
  WHERE o.paid_at >= p_trend_start AND o.paid_at < p_end
    AND o.payment_status IN ('paid','refund_pending','partially_refunded','refunded')
    AND o.source_channel <> 'youzan'
    AND (o.sale_location_id = ANY(loc.ids) OR (p_include_unassigned AND o.sale_location_id IS NULL))
),
order_items AS (
  SELECT oi.order_id, SUM(oi.quantity)::bigint AS qty
  FROM public.commerce_order_items oi
  WHERE oi.order_id IN (SELECT id FROM paid_orders)
  GROUP BY oi.order_id
),
c_refunds AS (
  SELECT r.refunded_at, r.amount, o.source_channel
  FROM public.commerce_refunds r
  JOIN public.commerce_orders o ON o.id = r.order_id, loc
  WHERE r.status = 'succeeded'
    AND r.refunded_at >= p_trend_start AND r.refunded_at < p_end
    AND o.source_channel <> 'youzan'
    AND (o.sale_location_id = ANY(loc.ids) OR (p_include_unassigned AND o.sale_location_id IS NULL))
),
pos_ret AS (
  SELECT r.id, COALESCE(r.completed_at, r.created_at) AS at, r.refund_total
  FROM public.pos_returns r, loc
  WHERE r.status IN ('completed','refunded')
    AND COALESCE(r.completed_at, r.created_at) >= p_trend_start
    AND COALESCE(r.completed_at, r.created_at) < p_end
    AND r.location_id = ANY(loc.ids)
),
pos_ret_qty AS (
  SELECT COALESCE(SUM(ri.quantity), 0)::bigint AS qty
  FROM public.pos_return_items ri
  JOIN pos_ret pr ON pr.id = ri.return_id
  WHERE pr.at >= p_start AND pr.at < p_end
),
yz AS (
  SELECT y.pay_time, y.shop_id,
         COALESCE(y.payment, y.total_fee, 0) - COALESCE(y.post_fee, 0) AS net_amount,
         COALESCE(y.item_count, y.num, 0) AS qty
  FROM public.youzan_orders y, shops
  WHERE y.pay_time >= p_trend_start AND y.pay_time < p_end
    AND y.status = 'TRADE_SUCCESS'
    AND y.shop_id = ANY(shops.ids)
),
win_orders AS (SELECT * FROM paid_orders WHERE paid_at >= p_start AND paid_at < p_end),
win_yz AS (SELECT * FROM yz WHERE pay_time >= p_start AND pay_time < p_end),
chan AS (
  SELECT
    COALESCE(SUM(CASE WHEN source_channel = 'pos' THEN ROUND(total_amount * 100) END), 0)::bigint AS pos_gross,
    COUNT(*) FILTER (WHERE source_channel = 'pos')::bigint AS pos_orders,
    COALESCE(SUM(CASE WHEN source_channel <> 'pos' THEN ROUND(total_amount * 100) END), 0)::bigint AS store_gross,
    COUNT(*) FILTER (WHERE source_channel <> 'pos')::bigint AS store_orders
  FROM win_orders
),
refund_win AS (
  SELECT
    (SELECT COALESCE(SUM(ROUND(refund_total * 100)), 0)::bigint FROM pos_ret WHERE at >= p_start AND at < p_end) AS pos_refund,
    (SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint FROM c_refunds
      WHERE refunded_at >= p_start AND refunded_at < p_end AND source_channel <> 'pos') AS store_refund
),
yz_win AS (
  SELECT COALESCE(SUM(ROUND(net_amount * 100)), 0)::bigint AS gross,
         COUNT(*)::bigint AS orders,
         COALESCE(SUM(qty), 0)::bigint AS qty
  FROM win_yz
),
items_win AS (
  SELECT COALESCE(SUM(oi.qty), 0)::bigint AS qty
  FROM order_items oi WHERE oi.order_id IN (SELECT id FROM win_orders)
),
trend AS (
  SELECT d::date AS day,
    (
      (SELECT COALESCE(SUM(ROUND(o.total_amount * 100)), 0)::bigint FROM paid_orders o
        WHERE (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date = d::date)
      - (SELECT COALESCE(SUM(ROUND(r.amount * 100)), 0)::bigint FROM c_refunds r
        WHERE (r.refunded_at AT TIME ZONE 'Asia/Shanghai')::date = d::date)
      - (SELECT COALESCE(SUM(ROUND(pr.refund_total * 100)), 0)::bigint FROM pos_ret pr
        WHERE (pr.at AT TIME ZONE 'Asia/Shanghai')::date = d::date)
      + (SELECT COALESCE(SUM(ROUND(y.net_amount * 100)), 0)::bigint FROM yz y
        WHERE (y.pay_time AT TIME ZONE 'Asia/Shanghai')::date = d::date)
    ) AS net_sales_fen,
    (
      (SELECT COUNT(*) FROM paid_orders o WHERE (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date = d::date)
      + (SELECT COUNT(*) FROM yz y WHERE (y.pay_time AT TIME ZONE 'Asia/Shanghai')::date = d::date)
    )::bigint AS order_count
  FROM generate_series(
        (p_trend_start AT TIME ZONE 'Asia/Shanghai')::date,
        ((p_end AT TIME ZONE 'Asia/Shanghai') - interval '1 second')::date,
        interval '1 day') AS d
),
todo AS (
  SELECT
    (SELECT COUNT(*) FROM public.fulfillments f, loc
      WHERE f.location_id = ANY(loc.ids) AND f.status IN ('unallocated','allocated','picking'))::bigint AS pending_pick,
    (SELECT COUNT(*) FROM public.fulfillments f, loc
      WHERE f.location_id = ANY(loc.ids) AND f.status IN ('picked','packing','packed','handover_ready'))::bigint AS pending_ship,
    (SELECT COUNT(*) FROM public.fulfillment_shortages s
      JOIN public.fulfillments f ON f.id = s.fulfillment_id, loc
      WHERE f.location_id = ANY(loc.ids) AND s.status = 'pending_customer')::bigint AS shortage_pending_customer,
    (SELECT COUNT(*) FROM public.commerce_after_sales a, loc
      WHERE (a.location_id = ANY(loc.ids) OR (p_include_unassigned AND a.location_id IS NULL))
        AND a.status NOT IN ('refunded','closed','cancelled','rejected'))::bigint AS after_sales_open,
    (SELECT COUNT(*) FROM public.support_conversations c, loc
      WHERE (c.location_id = ANY(loc.ids) OR (p_include_unassigned AND c.location_id IS NULL))
        AND c.status <> 'closed'
        AND (SELECT m.sender_type FROM public.support_messages m
              WHERE m.conversation_id = c.id AND m.internal IS NOT TRUE
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = 'customer')::bigint AS support_unanswered,
    (
      (SELECT COUNT(*) FROM public.channel_sync_outbox q, shops
        WHERE q.status = 'failed' AND (q.shop_id = ANY(shops.ids) OR (p_include_unassigned AND q.shop_id IS NULL)))
      + (SELECT COUNT(*) FROM public.youzan_stock_sync_queue q, shops
        WHERE q.status = 'failed' AND (q.shop_id = ANY(shops.ids) OR (p_include_unassigned AND q.shop_id IS NULL)))
    )::bigint AS sync_failed
),
watermark AS (
  SELECT
    (SELECT MAX(o.paid_at) FROM public.commerce_orders o, loc
      WHERE o.payment_status IN ('paid','refund_pending','partially_refunded','refunded')
        AND (o.sale_location_id = ANY(loc.ids) OR (p_include_unassigned AND o.sale_location_id IS NULL))) AS commerce_paid_at,
    (SELECT MAX(y.pay_time) FROM public.youzan_orders y, shops WHERE y.shop_id = ANY(shops.ids)) AS youzan_paid_at,
    (SELECT MAX(l.finished_at) FROM public.youzan_sync_logs l, shops
      WHERE l.shop_id = ANY(shops.ids) AND l.status = 'success') AS youzan_synced_at
)
SELECT jsonb_build_object(
  'pos', jsonb_build_object(
    'gross_fen', chan.pos_gross, 'refund_fen', refund_win.pos_refund,
    'net_sales_fen', chan.pos_gross - refund_win.pos_refund, 'order_count', chan.pos_orders),
  'storefront', jsonb_build_object(
    'gross_fen', chan.store_gross, 'refund_fen', refund_win.store_refund,
    'net_sales_fen', chan.store_gross - refund_win.store_refund, 'order_count', chan.store_orders),
  'youzan', jsonb_build_object(
    'gross_fen', yz_win.gross, 'refund_fen', NULL,
    'net_sales_fen', yz_win.gross, 'order_count', yz_win.orders, 'items', yz_win.qty),
  'items_sold', items_win.qty + yz_win.qty - (SELECT qty FROM pos_ret_qty),
  'trend', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'date', to_char(t.day, 'YYYY-MM-DD'),
      'net_sales_fen', t.net_sales_fen,
      'order_count', t.order_count) ORDER BY t.day), '[]'::jsonb) FROM trend t),
  'todo', to_jsonb(todo.*),
  'watermarks', jsonb_build_object(
    'commerce_last_paid_at', watermark.commerce_paid_at,
    'youzan_last_paid_at', watermark.youzan_paid_at,
    'youzan_last_synced_at', watermark.youzan_synced_at)
)
FROM chan, refund_win, yz_win, items_win, todo, watermark;
$$;

REVOKE ALL ON FUNCTION public.sales_dashboard_report(uuid[], uuid[], boolean, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sales_dashboard_report(uuid[], uuid[], boolean, timestamptz, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.sales_dashboard_report(uuid[], uuid[], boolean, timestamptz, timestamptz, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sales_dashboard_report(uuid[], uuid[], boolean, timestamptz, timestamptz, timestamptz) TO service_role;