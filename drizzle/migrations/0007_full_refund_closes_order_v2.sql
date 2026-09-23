-- 全额退款成功 → 订单原子关闭；已全退订单禁止继续拣货/出库；历史回填留审计。
CREATE TABLE IF NOT EXISTS public.commerce_order_status_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commerce_order_status_audit_order_idx
  ON public.commerce_order_status_audit(order_id, created_at DESC);
REVOKE ALL ON public.commerce_order_status_audit FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.commerce_order_status_audit TO service_role;
ALTER TABLE public.commerce_order_status_audit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.commerce_close_order_if_fully_refunded(p_order_id uuid, p_reason text, p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_order public.commerce_orders; v_ok boolean;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.payment_status <> 'refunded' OR v_order.order_status IN ('closed','cancelled') THEN
    RETURN false;
  END IF;
  SELECT bool_and(p.status = 'refunded' AND p.amount = coalesce((
           SELECT sum(r.amount) FROM public.commerce_refunds r
            WHERE r.payment_id = p.id AND r.status = 'succeeded'), 0))
         AND count(*) > 0
    INTO v_ok
    FROM public.commerce_payments p
   WHERE p.order_id = p_order_id AND p.status IN ('succeeded','partially_refunded','refunded');
  IF NOT coalesce(v_ok, false) THEN RETURN false; END IF;
  INSERT INTO public.commerce_order_status_audit(order_id, from_status, to_status, reason, evidence)
    VALUES (p_order_id, v_order.order_status, 'closed', p_reason,
            coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('previous_updated_at', v_order.updated_at));
  UPDATE public.commerce_orders SET order_status = 'closed', updated_at = now() WHERE id = p_order_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.commerce_close_order_if_fully_refunded(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_close_order_if_fully_refunded(uuid, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_apply_ordinary_refund(p_event jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v public.commerce_refunds; v_payment public.commerce_payments; v_event public.commerce_payment_events;
  v_payment_id uuid; v_sum numeric; v_order_id uuid;
BEGIN
  SELECT payment_id,order_id INTO v_payment_id,v_order_id FROM public.commerce_refunds
    WHERE merchant_refund_no=p_event->>'merchant_refund_no';
  IF NOT FOUND THEN RAISE EXCEPTION 'ordinary refund not found'; END IF;
  PERFORM 1 FROM public.commerce_orders WHERE id=v_order_id FOR UPDATE;
  SELECT * INTO v_payment FROM public.commerce_payments WHERE id=v_payment_id FOR UPDATE;
  SELECT * INTO v FROM public.commerce_refunds WHERE merchant_refund_no=p_event->>'merchant_refund_no' FOR UPDATE;
  IF nullif(p_event->>'event_id','') IS NULL OR p_event->>'status' IS NULL
    OR p_event->>'status' NOT IN ('succeeded','failed','cancelled') OR nullif(p_event->>'provider_refund_id','') IS NULL
    OR p_event->>'merchant_id' IS DISTINCT FROM v.route_snapshot->>'merchant_id'
    OR p_event->>'transaction_id' IS DISTINCT FROM v_payment.provider_transaction_id
    OR (p_event->>'total_fen')::numeric IS DISTINCT FROM v_payment.amount*100
    OR (p_event->>'refund_fen')::numeric IS DISTINCT FROM v.amount*100
    OR (v.provider_refund_id IS NOT NULL AND v.provider_refund_id<>p_event->>'provider_refund_id') THEN
    RAISE EXCEPTION 'refund event snapshot mismatch'; END IF;
  INSERT INTO public.commerce_payment_events(payment_id,provider,provider_event_id,event_type,signature_verified,payload)
    VALUES(v_payment.id,'wechat',p_event->>'event_id','ordinary.refund.'||(p_event->>'status'),true,p_event)
    ON CONFLICT(provider,provider_event_id) DO NOTHING;
  SELECT * INTO v_event FROM public.commerce_payment_events WHERE provider='wechat' AND provider_event_id=p_event->>'event_id' FOR UPDATE;
  IF v_event.payment_id IS DISTINCT FROM v_payment.id OR v_event.payload IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'refund event replay mismatch'; END IF;
  IF v_event.processing_status='processed' THEN RETURN jsonb_build_object('refund',to_jsonb(v),'replayed',true); END IF;
  IF v.status<>'succeeded' THEN
    IF p_event->>'status'='succeeded' AND nullif(p_event->>'refunded_at','') IS NULL THEN RAISE EXCEPTION 'invalid refund success time'; END IF;
    UPDATE public.commerce_refunds SET status=p_event->>'status',provider_refund_id=p_event->>'provider_refund_id',
      refunded_at=CASE WHEN p_event->>'status'='succeeded' THEN (p_event->>'refunded_at')::timestamptz ELSE NULL END,
      lease_token=NULL WHERE id=v.id RETURNING * INTO v;
    IF v.status='succeeded' THEN
      SELECT coalesce(sum(amount),0) INTO v_sum FROM public.commerce_refunds WHERE payment_id=v.payment_id AND status='succeeded';
      IF v_sum>v_payment.amount THEN RAISE EXCEPTION 'refund amount exceeds payment limit'; END IF;
      UPDATE public.commerce_payments SET status=CASE WHEN v_sum=amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() WHERE id=v.payment_id;
      UPDATE public.commerce_orders SET payment_status=CASE WHEN v_sum=total_amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() WHERE id=v.order_id;
      UPDATE public.commerce_after_sales SET status='refunded',refunded_at=v.refunded_at,updated_at=now() WHERE id=v.after_sale_id;
      PERFORM public.commerce_close_order_if_fully_refunded(v.order_id, 'full_refund_succeeded',
        jsonb_build_object('refund_id', v.id, 'payment_id', v.payment_id, 'succeeded_refund_total', v_sum,
                           'event_id', p_event->>'event_id'));
    END IF;
  END IF;
  UPDATE public.commerce_payment_events SET processing_status='processed',processed_at=now() WHERE id=v_event.id;
  RETURN jsonb_build_object('refund',to_jsonb(v),'replayed',false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.commerce_order_is_refund_closed(p_order_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.commerce_orders
                  WHERE id = p_order_id AND (payment_status = 'refunded' OR order_status = 'closed'));
$$;
REVOKE ALL ON FUNCTION public.commerce_order_is_refund_closed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_order_is_refund_closed(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_fulfillment_block_refunded()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF OLD.status NOT IN ('handed_over','exception') AND NEW.status <> 'exception'
     AND public.commerce_order_is_refund_closed(NEW.order_id) THEN
    RAISE EXCEPTION 'fulfillment blocked: order_refunded';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fulfillments_block_refunded ON public.fulfillments;
CREATE TRIGGER fulfillments_block_refunded BEFORE UPDATE ON public.fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_block_refunded();

CREATE OR REPLACE FUNCTION public.tg_fulfillment_child_block_refunded()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_order uuid; v_status text;
BEGIN
  IF TG_TABLE_NAME = 'fulfillment_items' THEN
    IF NEW.picked_qty <= OLD.picked_qty THEN RETURN NEW; END IF;
  END IF;
  SELECT order_id, status INTO v_order, v_status FROM public.fulfillments WHERE id = NEW.fulfillment_id;
  IF v_status NOT IN ('handed_over','exception') AND public.commerce_order_is_refund_closed(v_order) THEN
    RAISE EXCEPTION 'fulfillment blocked: order_refunded';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fulfillment_items_block_refunded ON public.fulfillment_items;
CREATE TRIGGER fulfillment_items_block_refunded BEFORE UPDATE OF picked_qty ON public.fulfillment_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_child_block_refunded();
DROP TRIGGER IF EXISTS shipments_block_refunded ON public.shipments;
CREATE TRIGGER shipments_block_refunded BEFORE INSERT ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_child_block_refunded();

SELECT public.commerce_close_order_if_fully_refunded(o.id, 'backfill_full_refund_ledger_verified',
         jsonb_build_object('backfill', true))
  FROM public.commerce_orders o
 WHERE o.payment_status = 'refunded' AND o.order_status NOT IN ('closed','cancelled');
