-- 缺货申报 → 客户确认 → 自动原路退款 v1（全部增量，兼容旧腾讯版本）

-- 1) fulfillment_shortages 扩展
ALTER TABLE public.fulfillment_shortages
  ADD COLUMN IF NOT EXISTS order_item_id uuid REFERENCES public.commerce_order_items(id),
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.inv_locations(id),
  ADD COLUMN IF NOT EXISTS product_name text,
  ADD COLUMN IF NOT EXISTS image_ref text,
  ADD COLUMN IF NOT EXISTS quote_version text,
  ADD COLUMN IF NOT EXISTS refund_goods_fen integer,
  ADD COLUMN IF NOT EXISTS refund_shipping_fen integer,
  ADD COLUMN IF NOT EXISTS refund_total_fen integer,
  ADD COLUMN IF NOT EXISTS quote_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS after_sale_id uuid REFERENCES public.commerce_after_sales(id),
  ADD COLUMN IF NOT EXISTS refund_intent_id uuid,
  ADD COLUMN IF NOT EXISTS refund_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

ALTER TABLE public.fulfillment_shortages DROP CONSTRAINT IF EXISTS fulfillment_shortages_refund_state_check;
ALTER TABLE public.fulfillment_shortages ADD CONSTRAINT fulfillment_shortages_refund_state_check
  CHECK (refund_state = ANY (ARRAY[
    'not_required','refund_pending','refund_completed',
    'awaiting_confirmation','queued','processing','succeeded','failed','manual_review'
  ]));

-- 2) 客户售后/交易通知（客户入口，绝不复用员工 inv_handheld_notifications）
CREATE TABLE IF NOT EXISTS public.commerce_customer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'shortage',
  title text NOT NULL,
  body text NOT NULL,
  shortage_id uuid REFERENCES public.fulfillment_shortages(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_customer_notifications_dedupe
  ON public.commerce_customer_notifications (customer_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_customer_notifications_customer_idx
  ON public.commerce_customer_notifications (customer_id, created_at DESC);
GRANT ALL ON public.commerce_customer_notifications TO service_role;
ALTER TABLE public.commerce_customer_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages customer notifications"
  ON public.commerce_customer_notifications FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3) 业务短信 outbox（与 OTP 完全独立，默认不发送）
CREATE TABLE IF NOT EXISTS public.commerce_sms_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  phone text NOT NULL,
  params jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending','template_missing','sending','sent','failed','skipped_disabled'])),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  provider_serial text,
  provider_code text,
  provider_message text,
  dedupe_key text,
  shortage_id uuid REFERENCES public.fulfillment_shortages(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.commerce_customers(id) ON DELETE SET NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_sms_outbox_dedupe
  ON public.commerce_sms_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS commerce_sms_outbox_pending_idx
  ON public.commerce_sms_outbox (status, created_at);
GRANT ALL ON public.commerce_sms_outbox TO service_role;
ALTER TABLE public.commerce_sms_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages business sms outbox"
  ON public.commerce_sms_outbox FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4) 退款意图 + 持久退款任务（每个缺货最多一个意图）
CREATE TABLE IF NOT EXISTS public.commerce_refund_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortage_id uuid NOT NULL UNIQUE REFERENCES public.fulfillment_shortages(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL REFERENCES public.commerce_payments(id) ON DELETE RESTRICT,
  after_sale_id uuid REFERENCES public.commerce_after_sales(id) ON DELETE SET NULL,
  refund_id uuid REFERENCES public.commerce_refunds(id) ON DELETE SET NULL,
  amount_fen integer NOT NULL CHECK (amount_fen > 0),
  goods_fen integer NOT NULL DEFAULT 0,
  shipping_fen integer NOT NULL DEFAULT 0,
  quote_version text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state = ANY (ARRAY['queued','processing','succeeded','failed','manual_review'])),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commerce_refund_intents_claim_idx
  ON public.commerce_refund_intents (state, next_attempt_at);
GRANT ALL ON public.commerce_refund_intents TO service_role;
ALTER TABLE public.commerce_refund_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages refund intents"
  ON public.commerce_refund_intents FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER commerce_refund_intents_touch BEFORE UPDATE ON public.commerce_refund_intents
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER commerce_sms_outbox_touch BEFORE UPDATE ON public.commerce_sms_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 5) 缺货申报：原子锁定实际可申报数量 + 客户待办 + 通知 + 短信 outbox
CREATE OR REPLACE FUNCTION public.shortage_report_v1(
  p_fulfillment_id uuid,
  p_fulfillment_item_id uuid,
  p_quantity integer,
  p_reason text,
  p_client_op_id text,
  p_reported_by uuid,
  p_device_id uuid,
  p_quote jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.fulfillment_items%ROWTYPE;
  v_fulfillment public.fulfillments%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_declared integer;
  v_available integer;
  v_shortage public.fulfillment_shortages%ROWTYPE;
  v_customer_id uuid;
  v_phone text;
  v_title text;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_client_op_id IS NULL OR length(p_client_op_id) = 0 THEN RAISE EXCEPTION 'client_op_id_required'; END IF;

  SELECT * INTO v_shortage FROM public.fulfillment_shortages
    WHERE fulfillment_id = p_fulfillment_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'replayed', true);
  END IF;

  -- 行级锁：发货与缺货互斥，防止并发超额申报
  SELECT * INTO v_item FROM public.fulfillment_items
    WHERE id = p_fulfillment_item_id AND fulfillment_id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'line_mismatch'; END IF;

  SELECT * INTO v_fulfillment FROM public.fulfillments WHERE id = p_fulfillment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_not_found'; END IF;

  SELECT coalesce(sum(quantity), 0) INTO v_declared FROM public.fulfillment_shortages
    WHERE fulfillment_item_id = p_fulfillment_item_id AND status <> 'withdrawn';

  v_available := coalesce(v_item.expected_qty, 0) - coalesce(v_item.picked_qty, 0) - v_declared;
  IF v_available <= 0 THEN RAISE EXCEPTION 'no_declarable_quantity'; END IF;
  IF p_quantity > v_available THEN RAISE EXCEPTION 'quantity_exceeds_declarable'; END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_fulfillment.order_id;

  INSERT INTO public.fulfillment_shortages (
    fulfillment_id, fulfillment_item_id, order_id, order_item_id, location_id,
    quantity, reason, status, refund_state, reported_by, device_id, client_op_id,
    product_name, image_ref, quote_version, refund_goods_fen, refund_shipping_fen,
    refund_total_fen, quote_snapshot
  ) VALUES (
    p_fulfillment_id, p_fulfillment_item_id, v_fulfillment.order_id, v_item.order_item_id,
    v_fulfillment.location_id, p_quantity, p_reason, 'pending_customer', 'awaiting_confirmation',
    p_reported_by, p_device_id, p_client_op_id,
    nullif(p_quote->>'product_name',''), nullif(p_quote->>'image_ref',''),
    nullif(p_quote->>'quote_version',''),
    nullif(p_quote->>'refund_goods_fen','')::integer,
    nullif(p_quote->>'refund_shipping_fen','')::integer,
    nullif(p_quote->>'refund_total_fen','')::integer,
    p_quote
  ) RETURNING * INTO v_shortage;

  v_customer_id := v_order.customer_id;
  v_title := '订单商品缺货，请确认退款';

  IF v_customer_id IS NOT NULL THEN
    INSERT INTO public.commerce_customer_notifications (
      customer_id, kind, title, body, shortage_id, order_id, dedupe_key
    ) VALUES (
      v_customer_id, 'shortage', v_title,
      format('订单 %s 中「%s」缺货 %s 件，请在订单售后中确认退款金额。',
             coalesce(v_order.order_no,''), coalesce(nullif(p_quote->>'product_name',''),'商品'), p_quantity),
      v_shortage.id, v_order.id, 'shortage:' || v_shortage.id || ':reported'
    ) ON CONFLICT DO NOTHING;

    SELECT phone INTO v_phone FROM public.commerce_customers WHERE id = v_customer_id;
    IF v_phone IS NOT NULL AND length(v_phone) > 0 THEN
      INSERT INTO public.commerce_sms_outbox (
        template_key, phone, params, shortage_id, order_id, customer_id, dedupe_key
      ) VALUES (
        'shortage_reported', v_phone,
        jsonb_build_array(coalesce(v_order.order_no,''), p_quantity::text),
        v_shortage.id, v_order.id, v_customer_id, 'shortage:' || v_shortage.id || ':reported'
      ) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'replayed', false,
                            'declarable_before', v_available);
END;
$$;
REVOKE ALL ON FUNCTION public.shortage_report_v1(uuid,uuid,integer,text,text,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shortage_report_v1(uuid,uuid,integer,text,text,uuid,uuid,jsonb) TO service_role;

-- 6) 客户确认：校验归属 + 报价版本 → 系统核定售后 + 唯一退款意图（无总部审批）
CREATE OR REPLACE FUNCTION public.shortage_confirm_refund_v1(
  p_shortage_id uuid,
  p_customer_id uuid,
  p_quote_version text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shortage public.fulfillment_shortages%ROWTYPE;
  v_order public.commerce_orders%ROWTYPE;
  v_payment public.commerce_payments%ROWTYPE;
  v_intent public.commerce_refund_intents%ROWTYPE;
  v_after_sale public.commerce_after_sales%ROWTYPE;
BEGIN
  SELECT * INTO v_shortage FROM public.fulfillment_shortages WHERE id = p_shortage_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  SELECT * INTO v_order FROM public.commerce_orders WHERE id = v_shortage.order_id;
  IF NOT FOUND OR v_order.customer_id IS DISTINCT FROM p_customer_id THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_intent FROM public.commerce_refund_intents WHERE shortage_id = p_shortage_id;
  IF FOUND THEN
    -- 重复确认：返回当前同一意图状态，不新建第二个意图
    RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'intent', to_jsonb(v_intent), 'replayed', true);
  END IF;

  IF v_shortage.quote_version IS NULL OR v_shortage.quote_version IS DISTINCT FROM p_quote_version THEN
    RAISE EXCEPTION 'QUOTE_CHANGED';
  END IF;
  IF coalesce(v_shortage.refund_total_fen, 0) <= 0 THEN RAISE EXCEPTION 'no_refundable_amount'; END IF;
  IF v_shortage.refund_state <> 'awaiting_confirmation' THEN RAISE EXCEPTION 'not_confirmable'; END IF;

  SELECT * INTO v_payment FROM public.commerce_payments
    WHERE order_id = v_order.id AND status = 'succeeded'
    ORDER BY paid_at DESC NULLS LAST, created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'paid_payment_not_found'; END IF;

  INSERT INTO public.commerce_after_sales (
    after_sale_no, order_id, order_item_id, location_id, user_id, type, status,
    reason_code, reason_text, requested_amount, approved_amount, requested_at, refund_requested_at
  ) VALUES (
    public.gen_commerce_after_sale_no(), v_order.id, v_shortage.order_item_id,
    v_shortage.location_id, coalesce(v_order.user_id, v_order.customer_id),
    'refund_only', 'refund_pending', 'stock_shortage', v_shortage.reason,
    round(v_shortage.refund_total_fen::numeric / 100, 2),
    round(v_shortage.refund_total_fen::numeric / 100, 2),
    now(), now()
  ) RETURNING * INTO v_after_sale;

  INSERT INTO public.commerce_refund_intents (
    shortage_id, order_id, customer_id, payment_id, after_sale_id,
    amount_fen, goods_fen, shipping_fen, quote_version, idempotency_key, state
  ) VALUES (
    v_shortage.id, v_order.id, p_customer_id, v_payment.id, v_after_sale.id,
    v_shortage.refund_total_fen, coalesce(v_shortage.refund_goods_fen,0),
    coalesce(v_shortage.refund_shipping_fen,0), p_quote_version, p_idempotency_key, 'queued'
  ) RETURNING * INTO v_intent;

  UPDATE public.fulfillment_shortages SET
    status = 'customer_accepted',
    refund_state = 'queued',
    after_sale_id = v_after_sale.id,
    refund_intent_id = v_intent.id,
    customer_responded_at = coalesce(customer_responded_at, now()),
    refund_requested_at = now(),
    updated_at = now()
  WHERE id = v_shortage.id RETURNING * INTO v_shortage;

  INSERT INTO public.commerce_customer_notifications (
    customer_id, kind, title, body, shortage_id, order_id, dedupe_key
  ) VALUES (
    p_customer_id, 'refund', '退款已受理',
    format('订单 %s 的缺货退款 %s 元已受理，将按原支付方式退回。',
           coalesce(v_order.order_no,''), round(v_shortage.refund_total_fen::numeric/100, 2)),
    v_shortage.id, v_order.id, 'shortage:' || v_shortage.id || ':refund_queued'
  ) ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('shortage', to_jsonb(v_shortage), 'intent', to_jsonb(v_intent), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.shortage_confirm_refund_v1(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shortage_confirm_refund_v1(uuid,uuid,text,text) TO service_role;