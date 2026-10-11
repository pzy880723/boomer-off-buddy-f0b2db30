-- 已付款订单 → 门店手持持久提醒（kind=order_paid，每个履约门店一条）。
-- 回滚：DROP TRIGGER trg_order_paid_notify ON public.commerce_orders; DROP TRIGGER trg_order_paid_void ON public.commerce_orders;
--   DROP TRIGGER trg_fulfillment_paid_notify ON public.fulfillments; DROP TRIGGER trg_fulfillment_notify_handled ON public.fulfillments;
--   DROP FUNCTION public.tg_order_paid_notify(); DROP FUNCTION public.tg_order_paid_void(); DROP FUNCTION public.tg_fulfillment_paid_notify();
--   DROP FUNCTION public.tg_fulfillment_notify_handled(); DROP FUNCTION public.handheld_notify_order_paid(uuid);
--   DROP INDEX public.uq_handheld_notif_order_paid; (kind 约束保留 order_paid 为加宽，无需回退)
ALTER TABLE public.inv_handheld_notifications DROP CONSTRAINT IF EXISTS inv_handheld_notifications_kind_check;
ALTER TABLE public.inv_handheld_notifications ADD CONSTRAINT inv_handheld_notifications_kind_check
  CHECK (kind = ANY (ARRAY['stocktake_assigned','transfer_incoming','youzan_sync_failed','unclaimed_epc_pending','system','order_paid']));

CREATE UNIQUE INDEX IF NOT EXISTS uq_handheld_notif_order_paid
  ON public.inv_handheld_notifications (ref_id) WHERE kind = 'order_paid';

CREATE OR REPLACE FUNCTION public.handheld_notify_order_paid(p_order_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  INSERT INTO public.inv_handheld_notifications (location_id, kind, title, payload, ts, audience, ref_type, ref_id)
  SELECT f.location_id, 'order_paid', '新的已付款订单',
    jsonb_build_object(
      'order_id', o.id, 'order_no', o.order_no,
      'fulfillment_id', f.id, 'fulfillment_code', f.code,
      'fulfillment_method', o.fulfillment_method,
      'sales_origin', CASE WHEN o.metadata->'sales_origin'->>'platform' IN ('miniapp','app','web')
                           THEN o.metadata->'sales_origin'->>'platform' ELSE 'unknown' END,
      'paid_at', o.paid_at),
    clock_timestamp(), 'location', 'fulfillment', f.id
  FROM public.commerce_orders o
  JOIN public.fulfillments f ON f.order_id = o.id
  WHERE o.id = p_order_id
    AND o.payment_status = 'paid'
    AND o.source_channel = 'storefront'
    AND o.order_status NOT IN ('cancelled','closed')
    AND f.location_id IS NOT NULL
  ORDER BY f.id
  ON CONFLICT (ref_id) WHERE kind = 'order_paid' DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.handheld_notify_order_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notify_order_paid(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_order_paid_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN PERFORM public.handheld_notify_order_paid(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'order_paid notify skipped: %', SQLSTATE; END;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.tg_fulfillment_paid_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN PERFORM public.handheld_notify_order_paid(NEW.order_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'order_paid notify skipped: %', SQLSTATE; END;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.tg_order_paid_void() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.inv_handheld_notifications n SET action_status = 'voided'
   WHERE n.kind = 'order_paid' AND n.action_status IS DISTINCT FROM 'voided'
     AND n.ref_id IN (SELECT f.id FROM public.fulfillments f WHERE f.order_id = NEW.id);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.tg_fulfillment_notify_handled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.inv_handheld_notifications SET action_status = 'handled'
   WHERE kind = 'order_paid' AND ref_id = NEW.id AND action_status IS NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.tg_order_paid_notify(), public.tg_fulfillment_paid_notify(),
  public.tg_order_paid_void(), public.tg_fulfillment_notify_handled() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_order_paid_notify ON public.commerce_orders;
CREATE TRIGGER trg_order_paid_notify AFTER UPDATE OF payment_status ON public.commerce_orders
  FOR EACH ROW WHEN (NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.tg_order_paid_notify();
DROP TRIGGER IF EXISTS trg_order_paid_void ON public.commerce_orders;
CREATE TRIGGER trg_order_paid_void AFTER UPDATE OF payment_status, order_status ON public.commerce_orders
  FOR EACH ROW WHEN (NEW.payment_status = 'refunded' OR NEW.order_status IN ('cancelled','closed'))
  EXECUTE FUNCTION public.tg_order_paid_void();
DROP TRIGGER IF EXISTS trg_fulfillment_paid_notify ON public.fulfillments;
CREATE TRIGGER trg_fulfillment_paid_notify AFTER INSERT ON public.fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_paid_notify();
DROP TRIGGER IF EXISTS trg_fulfillment_notify_handled ON public.fulfillments;
CREATE TRIGGER trg_fulfillment_notify_handled AFTER UPDATE OF status ON public.fulfillments
  FOR EACH ROW WHEN (NEW.status NOT IN ('unallocated','allocated') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.tg_fulfillment_notify_handled();