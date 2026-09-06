CREATE OR REPLACE FUNCTION public.handheld_search_order_ids(
  p_q text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_location_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  order_id uuid,
  derived_status text,
  fulfillment_count integer,
  handed_over_count integer,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT
      o.id,
      o.created_at,
      o.payment_status,
      o.order_status,
      (SELECT count(*) FROM public.fulfillments f WHERE f.order_id = o.id)::int AS f_total,
      (SELECT count(*) FROM public.fulfillments f WHERE f.order_id = o.id AND f.status = 'handed_over')::int AS f_done
    FROM public.commerce_orders o
    WHERE (
        p_location_id IS NULL
        OR EXISTS (SELECT 1 FROM public.fulfillments f WHERE f.order_id = o.id AND f.location_id = p_location_id)
      )
      AND (
        p_q IS NULL OR btrim(p_q) = ''
        OR o.order_no ILIKE '%' || p_q || '%'
        OR EXISTS (
          SELECT 1 FROM public.commerce_order_items oi
          WHERE oi.order_id = o.id
            AND (
              oi.title_snapshot ILIKE '%' || p_q || '%'
              OR EXISTS (SELECT 1 FROM public.inv_skus s WHERE s.id = oi.sku_id AND s.barcode ILIKE '%' || p_q || '%')
            )
        )
      )
  ),
  derived AS (
    SELECT
      s.*,
      CASE
        WHEN s.order_status IN ('cancelled', 'closed') THEN 'cancelled'
        WHEN s.order_status = 'after_sale'
          OR s.payment_status IN ('refund_pending', 'partially_refunded', 'refunded')
          OR EXISTS (
            SELECT 1 FROM public.commerce_after_sales a
            WHERE a.order_id = s.id AND a.status NOT IN ('rejected', 'closed', 'cancelled')
          )
          THEN 'after_sales'
        WHEN s.order_status = 'completed' THEN 'completed'
        WHEN s.payment_status IS DISTINCT FROM 'paid' THEN 'unpaid'
        WHEN s.f_total > 0 AND s.f_done = s.f_total THEN 'shipped'
        ELSE 'pending'
      END AS derived_status
    FROM scoped s
  ),
  filtered AS (
    SELECT * FROM derived d
    WHERE p_status IS NULL OR p_status = 'all' OR d.derived_status = p_status
  ),
  counted AS (
    SELECT count(*)::bigint AS total FROM filtered
  )
  SELECT f.id, f.derived_status, f.f_total, f.f_done, c.total
  FROM filtered f
  CROSS JOIN counted c
  ORDER BY f.created_at DESC, f.id DESC
  LIMIT greatest(coalesce(p_limit, 20), 0)
  OFFSET greatest(coalesce(p_offset, 0), 0);
$$;

CREATE OR REPLACE FUNCTION public.handheld_search_fulfillment_ids(
  p_q text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_location_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  fulfillment_id uuid,
  order_cancelled boolean,
  has_pending_customer boolean,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT
      f.id,
      f.priority,
      f.created_at,
      coalesce(o.order_status IN ('cancelled', 'closed'), false) AS order_cancelled,
      EXISTS (
        SELECT 1 FROM public.fulfillment_shortages sh
        WHERE sh.fulfillment_id = f.id AND sh.status = 'pending_customer'
      ) AS has_pending_customer
    FROM public.fulfillments f
    LEFT JOIN public.commerce_orders o ON o.id = f.order_id
    WHERE (p_location_ids IS NULL OR f.location_id = ANY (p_location_ids))
      AND (
        p_q IS NULL OR btrim(p_q) = ''
        OR f.code ILIKE '%' || p_q || '%'
        OR o.order_no ILIKE '%' || p_q || '%'
        OR EXISTS (
          SELECT 1 FROM public.fulfillment_items fi
          LEFT JOIN public.commerce_order_items oi ON oi.id = fi.order_item_id
          LEFT JOIN public.inv_skus s ON s.id = fi.sku_id
          WHERE fi.fulfillment_id = f.id
            AND (
              oi.title_snapshot ILIKE '%' || p_q || '%'
              OR s.name ILIKE '%' || p_q || '%'
              OR s.barcode ILIKE '%' || p_q || '%'
            )
        )
      )
      AND (
        p_status IS NULL OR p_status = 'all'
        OR (p_status = 'cancelled' AND coalesce(o.order_status IN ('cancelled', 'closed'), false))
        OR (
          p_status <> 'cancelled'
          AND coalesce(o.order_status NOT IN ('cancelled', 'closed'), true)
          AND (
            (p_status = 'pending_customer' AND EXISTS (
                SELECT 1 FROM public.fulfillment_shortages sh
                WHERE sh.fulfillment_id = f.id AND sh.status = 'pending_customer'
              ))
            OR (p_status <> 'pending_customer' AND f.status = p_status)
          )
        )
      )
  ),
  counted AS (
    SELECT count(*)::bigint AS total FROM scoped
  )
  SELECT s.id, s.order_cancelled, s.has_pending_customer, c.total
  FROM scoped s
  CROSS JOIN counted c
  ORDER BY s.priority DESC NULLS LAST, s.created_at ASC, s.id ASC
  LIMIT greatest(coalesce(p_limit, 20), 0)
  OFFSET greatest(coalesce(p_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.handheld_search_order_ids(text, text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_search_fulfillment_ids(text, text, uuid[], integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_search_order_ids(text, text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_search_fulfillment_ids(text, text, uuid[], integer, integer) TO service_role;