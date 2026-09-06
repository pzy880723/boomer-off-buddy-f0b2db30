-- Authoritative pick completion. Keep the existing RPC signature and device scope.
CREATE OR REPLACE FUNCTION public.fulfillment_complete_pick(
  p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid
) RETURNS public.fulfillments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.fulfillments;
  v_order_status text;
BEGIN
  SELECT * INTO v_row FROM public.fulfillments
   WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  IF v_row.status <> 'picking'
     OR (v_row.claimed_device_id IS NOT NULL
         AND v_row.claimed_device_id IS DISTINCT FROM p_device_id) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking';
  END IF;

  SELECT order_status INTO v_order_status FROM public.commerce_orders
   WHERE id = v_row.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking: order_missing'; END IF;
  IF v_order_status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: order_cancelled';
  END IF;

  -- Lock the inputs before reading counts. The fulfillment lock also serializes
  -- pick scans and FK-backed child inserts; existing shortages can update independently.
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
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_shortages
     WHERE fulfillment_id = p_fulfillment_id
       AND status <> 'withdrawn' AND refund_state = 'refund_pending'
  ) THEN
    RAISE EXCEPTION 'fulfillment cannot complete picking: refund_pending';
  END IF;

  -- Customer acceptance alone never waives a whole line or an unsettled refund.
  IF EXISTS (
    SELECT 1 FROM public.fulfillment_items fi
     WHERE fi.fulfillment_id = p_fulfillment_id
       AND fi.picked_qty < greatest(fi.expected_qty::bigint - coalesce((
         SELECT sum(s.quantity) FROM public.fulfillment_shortages s
          WHERE s.fulfillment_id = p_fulfillment_id
            AND s.fulfillment_item_id = fi.id
            AND s.status = 'customer_accepted'
            AND s.refund_state IN ('refund_completed', 'not_required')
       ), 0), 0)
  ) THEN
    RAISE EXCEPTION 'fulfillment still has unpicked items';
  END IF;

  UPDATE public.fulfillments SET status = 'picked', picked_at = now(), updated_at = now()
   WHERE id = v_row.id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.fulfillment_complete_pick(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfillment_complete_pick(uuid,uuid,uuid) TO service_role;

-- Guard the insert itself: route-level reads cannot serialize against completion.
CREATE OR REPLACE FUNCTION public.tg_fulfillment_shortage_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.fulfillments;
  v_order_status text;
  v_item public.fulfillment_items;
  v_reported_qty bigint;
BEGIN
  -- Keep the completion RPC's lock order: fulfillment, order, items, shortages.
  SELECT * INTO v_row FROM public.fulfillments
   WHERE id = NEW.fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shortage_fulfillment_not_found'; END IF;
  IF v_row.status NOT IN ('allocated', 'picking') THEN
    RAISE EXCEPTION 'shortage_fulfillment_not_pickable';
  END IF;

  SELECT order_status INTO v_order_status FROM public.commerce_orders
   WHERE id = v_row.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shortage_order_not_found'; END IF;
  IF v_order_status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION 'shortage_order_cancelled';
  END IF;
  IF NEW.order_id IS NOT NULL AND NEW.order_id <> v_row.order_id THEN
    RAISE EXCEPTION 'shortage_order_mismatch';
  END IF;
  NEW.order_id := v_row.order_id;

  SELECT fi.* INTO v_item FROM public.fulfillment_items fi
   WHERE fi.id = NEW.fulfillment_item_id
     AND fi.fulfillment_id = v_row.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shortage_line_mismatch'; END IF;

  -- Lock all statuses so a concurrent withdrawal/confirmation is read consistently.
  PERFORM s.id FROM public.fulfillment_shortages s
   WHERE s.fulfillment_id = v_row.id AND s.fulfillment_item_id = v_item.id
   ORDER BY s.id FOR UPDATE;
  SELECT coalesce(sum(s.quantity), 0) INTO v_reported_qty
    FROM public.fulfillment_shortages s
   WHERE s.fulfillment_id = v_row.id
     AND s.fulfillment_item_id = v_item.id
     AND s.status <> 'withdrawn';

  -- Pending reports on other lines do not prevent reporting this line.
  -- Non-withdrawn reports reserve units regardless of customer/refund progress.
  IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'shortage_invalid_quantity';
  END IF;
  IF NEW.quantity::bigint > v_item.expected_qty::bigint - v_item.picked_qty - v_reported_qty THEN
    RAISE EXCEPTION 'shortage_quantity_exceeds_unpicked';
  END IF;

  -- A row version change also makes stale repeatable-read contenders abort,
  -- instead of missing a newly inserted shortage after waiting for this lock.
  UPDATE public.fulfillments SET updated_at = now()
   WHERE id = v_row.id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_fulfillment_shortage_insert_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fulfillment_shortage_insert_guard ON public.fulfillment_shortages;
CREATE TRIGGER trg_fulfillment_shortage_insert_guard
BEFORE INSERT ON public.fulfillment_shortages
FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_shortage_insert_guard();
