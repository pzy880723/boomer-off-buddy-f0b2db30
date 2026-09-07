-- Reference backup only. DO NOT restore after any ordinary order exists.
CREATE OR REPLACE FUNCTION public.commerce_release_expired_reservations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer := 0;
BEGIN
  WITH expired AS (
    UPDATE public.inventory_reservations r SET status = 'expired', released_at = now()
      FROM public.commerce_orders o WHERE r.order_id = o.id AND r.status = 'active'
        AND r.expires_at <= now() AND o.payment_status = 'unpaid'
      RETURNING r.listing_id, r.order_id
  ), restored AS (
    UPDATE public.commerce_listings l SET status = 'published', updated_at = now()
      FROM expired e WHERE l.id = e.listing_id AND l.status = 'reserved' RETURNING l.id
  ), closed AS (
    UPDATE public.commerce_orders o SET order_status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE o.payment_status = 'unpaid' AND o.order_status = 'pending_payment' AND o.reservation_expires_at <= now()
      RETURNING o.id
  )
  SELECT count(*) INTO v_count FROM closed;
  RETURN v_count;
END; $function$
