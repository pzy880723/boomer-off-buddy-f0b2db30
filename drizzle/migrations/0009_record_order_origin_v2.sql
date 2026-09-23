CREATE TABLE IF NOT EXISTS public.commerce_order_origin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  previous_sales_origin jsonb,
  new_sales_origin jsonb NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.commerce_order_origin_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.commerce_order_origin_audit TO service_role;
ALTER TABLE public.commerce_order_origin_audit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.commerce_record_order_origin(
  p_order_id uuid, p_customer_id uuid, p_platform text, p_evidence text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record; v_new jsonb;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('miniapp','app','web') THEN
    RAISE EXCEPTION 'invalid_platform' USING ERRCODE = '22023';
  END IF;
  IF p_evidence IS NULL OR p_evidence NOT IN ('client_reported','verified_miniapp_payment') THEN
    RAISE EXCEPTION 'invalid_evidence' USING ERRCODE = '22023';
  END IF;
  IF p_evidence = 'verified_miniapp_payment' AND p_platform <> 'miniapp' THEN
    RAISE EXCEPTION 'invalid_evidence' USING ERRCODE = '22023';
  END IF;
  SELECT id, customer_id, source_channel, metadata INTO o
    FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR p_customer_id IS NULL OR o.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF o.source_channel <> 'storefront' THEN
    RAISE EXCEPTION 'not_storefront_order' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(o.metadata -> 'sales_origin') IS NOT NULL THEN
    RETURN o.metadata -> 'sales_origin';
  END IF;
  v_new := jsonb_build_object('version', 1, 'platform', p_platform, 'evidence', p_evidence);
  UPDATE public.commerce_orders
     SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sales_origin', v_new)
   WHERE id = p_order_id;
  INSERT INTO public.commerce_order_origin_audit(order_id, previous_sales_origin, new_sales_origin, reason)
    VALUES (p_order_id, NULL, v_new, 'record_order_origin');
  RETURN v_new;
END $$;
REVOKE ALL ON FUNCTION public.commerce_record_order_origin(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_record_order_origin(uuid,uuid,text,text) TO service_role;

WITH target AS (
  SELECT o.id, o.metadata -> 'sales_origin' AS prev, p.id AS payment_id, p.created_at
    FROM public.commerce_orders o
    JOIN public.commerce_payments p ON p.order_id = o.id
   WHERE o.id = '620bf887-1945-4653-a049-fe24c06a6081'
     AND p.id = 'd5b31379-58b4-4e3e-b4cb-a1bd70fe3e6a'
     AND o.source_channel = 'storefront'
     AND p.payment_channel = 'ordinary_wechat'
     AND p.merchant_snapshot ->> 'app_id' = 'wx9aef0738067286b3'
     AND p.payer_openid IS NOT NULL
     AND jsonb_typeof(o.metadata -> 'sales_origin') IS NULL
     AND (SELECT count(*) FROM public.commerce_payments p2 WHERE p2.order_id = o.id) = 1
), upd AS (
  UPDATE public.commerce_orders o
     SET metadata = o.metadata || jsonb_build_object('sales_origin',
         jsonb_build_object('version',1,'platform','miniapp','evidence','verified_miniapp_payment'))
    FROM target t WHERE o.id = t.id
  RETURNING o.id
)
INSERT INTO public.commerce_order_origin_audit(order_id, previous_sales_origin, new_sales_origin, reason, evidence)
SELECT t.id, t.prev, jsonb_build_object('version',1,'platform','miniapp','evidence','verified_miniapp_payment'),
       'backfill_verified_miniapp_payment',
       jsonb_build_object('payment_id', t.payment_id, 'payment_channel', 'ordinary_wechat',
         'app_id', 'wx9aef0738067286b3', 'payment_created_at', t.created_at,
         'guard', 'startOrdinaryPayment requires platform=miniapp since f3633f33 (2026-09-08); commerce_prepare_ordinary_payment executable only by service_role')
  FROM target t JOIN upd u ON u.id = t.id;
