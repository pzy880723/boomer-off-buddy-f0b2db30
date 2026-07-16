-- Store-owned after-sales workflow for self-operated storefront orders.
-- Payment refunds are intentionally completed by a future payment callback,
-- not by an ERP button.

CREATE SEQUENCE IF NOT EXISTS public.commerce_after_sale_number_seq START 100001;

CREATE OR REPLACE FUNCTION public.gen_commerce_after_sale_no()
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'AS' || to_char(now(), 'YYYYMMDD') ||
    lpad(nextval('public.commerce_after_sale_number_seq')::text, 6, '0');
$$;

CREATE TABLE public.commerce_after_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  after_sale_no text NOT NULL UNIQUE DEFAULT public.gen_commerce_after_sale_no(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.commerce_order_items(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('return_refund', 'refund_only')),
  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested', 'store_reviewing', 'approved', 'rejected',
      'customer_shipping', 'store_received', 'inspecting',
      'refund_pending', 'refunded', 'closed', 'cancelled'
    )
  ),
  reason_code text NOT NULL,
  reason_text text,
  requested_amount numeric(12,2) NOT NULL CHECK (requested_amount > 0),
  approved_amount numeric(12,2) CHECK (approved_amount > 0),
  evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  return_tracking_no text,
  return_carrier text,
  assigned_to uuid,
  store_note text,
  rejection_reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  received_at timestamptz,
  inspected_at timestamptz,
  refund_requested_at timestamptz,
  refunded_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_active_commerce_after_sale_item
  ON public.commerce_after_sales(order_item_id)
  WHERE status NOT IN ('rejected', 'refunded', 'closed', 'cancelled');
CREATE INDEX idx_commerce_after_sales_store_status
  ON public.commerce_after_sales(location_id, status, requested_at DESC);
CREATE INDEX idx_commerce_after_sales_order
  ON public.commerce_after_sales(order_id, requested_at DESC);

ALTER TABLE public.commerce_after_sales ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.commerce_after_sales TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_create_after_sale(
  p_user_id uuid,
  p_order_item_id uuid,
  p_type text,
  p_reason_code text,
  p_reason_text text DEFAULT NULL,
  p_requested_amount numeric DEFAULT NULL,
  p_evidence_urls jsonb DEFAULT '[]'::jsonb
) RETURNS public.commerce_after_sales
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.commerce_order_items;
  v_order public.commerce_orders;
  v_after_sale public.commerce_after_sales;
  v_amount numeric;
BEGIN
  IF p_type NOT IN ('return_refund', 'refund_only') THEN
    RAISE EXCEPTION 'unsupported after-sale type';
  END IF;

  SELECT * INTO v_item
    FROM public.commerce_order_items
   WHERE id = p_order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order item not found'; END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE id = v_item.order_id
     AND user_id = p_user_id
     AND payment_status IN ('paid', 'partially_refunded');
  IF NOT FOUND THEN RAISE EXCEPTION 'order is not eligible for after-sale'; END IF;

  v_amount := coalesce(p_requested_amount, v_item.line_total);
  IF v_amount <= 0 OR v_amount > v_item.line_total THEN
    RAISE EXCEPTION 'requested refund amount exceeds order item amount';
  END IF;

  INSERT INTO public.commerce_after_sales (
    order_id, order_item_id, location_id, user_id, type,
    reason_code, reason_text, requested_amount, evidence_urls
  ) VALUES (
    v_item.order_id, v_item.id, v_item.location_id, p_user_id, p_type,
    trim(p_reason_code), nullif(trim(coalesce(p_reason_text, '')), ''),
    v_amount, coalesce(p_evidence_urls, '[]'::jsonb)
  ) RETURNING * INTO v_after_sale;

  UPDATE public.commerce_orders
     SET order_status = 'after_sale', updated_at = now()
   WHERE id = v_item.order_id;

  RETURN v_after_sale;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_transition_after_sale(
  p_after_sale_id uuid,
  p_next_status text,
  p_operator_id uuid DEFAULT NULL,
  p_store_note text DEFAULT NULL,
  p_approved_amount numeric DEFAULT NULL,
  p_rejection_reason text DEFAULT NULL
) RETURNS public.commerce_after_sales
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.commerce_after_sales;
  v_allowed boolean := false;
BEGIN
  SELECT * INTO v_row
    FROM public.commerce_after_sales
   WHERE id = p_after_sale_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'after-sale not found'; END IF;

  v_allowed := CASE v_row.status
    WHEN 'requested' THEN p_next_status IN ('store_reviewing', 'cancelled')
    WHEN 'store_reviewing' THEN p_next_status IN ('approved', 'rejected')
    WHEN 'approved' THEN p_next_status IN ('customer_shipping', 'store_received', 'refund_pending')
    WHEN 'customer_shipping' THEN p_next_status = 'store_received'
    WHEN 'store_received' THEN p_next_status = 'inspecting'
    WHEN 'inspecting' THEN p_next_status IN ('refund_pending', 'rejected')
    WHEN 'refund_pending' THEN p_next_status = 'refunded'
    WHEN 'refunded' THEN p_next_status = 'closed'
    WHEN 'rejected' THEN p_next_status = 'closed'
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid after-sale transition: % -> %', v_row.status, p_next_status;
  END IF;
  IF p_next_status = 'rejected' AND nullif(trim(coalesce(p_rejection_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'rejection reason is required';
  END IF;

  UPDATE public.commerce_after_sales
     SET status = p_next_status,
         assigned_to = coalesce(assigned_to, p_operator_id),
         store_note = coalesce(nullif(trim(coalesce(p_store_note, '')), ''), store_note),
         approved_amount = CASE
           WHEN p_next_status IN ('approved', 'refund_pending')
             THEN coalesce(p_approved_amount, approved_amount, requested_amount)
           ELSE approved_amount
         END,
         rejection_reason = CASE
           WHEN p_next_status = 'rejected' THEN trim(p_rejection_reason)
           ELSE rejection_reason
         END,
         reviewed_at = CASE
           WHEN p_next_status IN ('approved', 'rejected') THEN now()
           ELSE reviewed_at
         END,
         received_at = CASE WHEN p_next_status = 'store_received' THEN now() ELSE received_at END,
         inspected_at = CASE WHEN p_next_status = 'inspecting' THEN now() ELSE inspected_at END,
         refund_requested_at = CASE
           WHEN p_next_status = 'refund_pending' THEN now()
           ELSE refund_requested_at
         END,
         refunded_at = CASE WHEN p_next_status = 'refunded' THEN now() ELSE refunded_at END,
         closed_at = CASE
           WHEN p_next_status IN ('closed', 'cancelled') THEN now()
           ELSE closed_at
         END,
         updated_at = now()
   WHERE id = p_after_sale_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_create_after_sale(uuid,uuid,text,text,text,numeric,jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_transition_after_sale(uuid,text,uuid,text,numeric,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commerce_create_after_sale(uuid,uuid,text,text,text,numeric,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_transition_after_sale(uuid,text,uuid,text,numeric,text)
  TO service_role;
