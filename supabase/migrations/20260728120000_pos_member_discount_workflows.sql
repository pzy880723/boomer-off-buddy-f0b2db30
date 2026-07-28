-- POS workflows for a second-hand retail store: member benefits, governed
-- discounts, held carts and auditable returns.

ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS sale_ownership text NOT NULL DEFAULT 'owned',
  ADD COLUMN IF NOT EXISTS discount_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS settlement_party_ref text;

ALTER TABLE public.inv_skus
  DROP CONSTRAINT IF EXISTS inv_skus_sale_ownership_check;
ALTER TABLE public.inv_skus
  ADD CONSTRAINT inv_skus_sale_ownership_check
  CHECK (sale_ownership IN ('owned', 'consigned', 'vendor', 'trade_in'));

ALTER TABLE public.commerce_orders
  ADD COLUMN IF NOT EXISTS discount_total numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS benefit_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.commerce_order_items
  ADD COLUMN IF NOT EXISTS original_unit_price numeric(12,2),
  ADD COLUMN IF NOT EXISTS discount_total numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ownership_snapshot text;

CREATE TABLE public.pos_customer_wallets (
  customer_id uuid PRIMARY KEY REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  store_credit numeric(12,2) NOT NULL DEFAULT 0 CHECK (store_credit >= 0),
  member_level text NOT NULL DEFAULT '普通会员',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pos_customer_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('amount', 'percentage')),
  value numeric(12,2) NOT NULL CHECK (value > 0),
  min_spend numeric(12,2) NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'expired', 'void')),
  starts_at timestamptz,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_customer_coupons_customer
  ON public.pos_customer_coupons(customer_id, status, expires_at);

CREATE TABLE public.pos_discount_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES public.inv_locations(id),
  name text NOT NULL,
  scope text NOT NULL DEFAULT 'order' CHECK (scope IN ('order', 'line')),
  discount_type text NOT NULL CHECK (discount_type IN ('amount', 'percentage', 'final_price')),
  max_amount numeric(12,2),
  min_pay_rate numeric(6,4) NOT NULL DEFAULT 0.9
    CHECK (min_pay_rate > 0 AND min_pay_rate <= 1),
  requires_reason boolean NOT NULL DEFAULT true,
  allowed_roles text[] NOT NULL DEFAULT ARRAY['super_admin','hq_operator','store_manager'],
  applies_to_ownership text[] NOT NULL DEFAULT ARRAY['owned'],
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pos_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  operator_id uuid NOT NULL,
  authorizer_id uuid NOT NULL,
  action text NOT NULL,
  requested_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  status text NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'rejected', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_authorizations_operator
  ON public.pos_authorizations(operator_id, location_id, status, expires_at);

ALTER TABLE public.commerce_orders
  ADD COLUMN IF NOT EXISTS authorization_id uuid REFERENCES public.pos_authorizations(id);

CREATE TABLE public.pos_held_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  operator_id uuid NOT NULL,
  customer_id uuid REFERENCES public.commerce_customers(id),
  client_op_id text NOT NULL UNIQUE,
  note text,
  discount_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  benefit_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'resumed', 'cancelled', 'expired')),
  held_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_held_carts_shift
  ON public.pos_held_carts(shift_id, status, held_at DESC);

CREATE TABLE public.pos_held_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  held_cart_id uuid NOT NULL REFERENCES public.pos_held_carts(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  price_snapshot numeric(12,2) NOT NULL CHECK (price_snapshot >= 0),
  ownership_snapshot text NOT NULL DEFAULT 'owned',
  discount_eligible boolean NOT NULL DEFAULT true,
  UNIQUE (held_cart_id, sku_id)
);

CREATE TABLE public.pos_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  operator_id uuid NOT NULL,
  authorization_id uuid REFERENCES public.pos_authorizations(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN (
      'pending', 'refund_pending', 'refunded', 'inspection_pending', 'completed', 'rejected'
    )),
  refund_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (refund_total >= 0),
  client_op_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_pos_returns_order ON public.pos_returns(order_id, created_at DESC);

CREATE TABLE public.pos_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.pos_returns(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.commerce_order_items(id),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  refund_amount numeric(12,2) NOT NULL CHECK (refund_amount >= 0),
  physical_status text NOT NULL DEFAULT 'received'
    CHECK (physical_status IN ('not_received', 'received', 'damaged')),
  inspection_status text NOT NULL DEFAULT 'pending'
    CHECK (inspection_status IN ('pending', 'passed', 'rejected')),
  UNIQUE (return_id, order_item_id)
);

ALTER TABLE public.pos_customer_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_customer_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_discount_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_held_carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_held_cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_return_items ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.pos_customer_wallets TO service_role;
GRANT ALL ON public.pos_customer_coupons TO service_role;
GRANT ALL ON public.pos_discount_policies TO service_role;
GRANT ALL ON public.pos_authorizations TO service_role;
GRANT ALL ON public.pos_held_carts TO service_role;
GRANT ALL ON public.pos_held_cart_items TO service_role;
GRANT ALL ON public.pos_returns TO service_role;
GRANT ALL ON public.pos_return_items TO service_role;

CREATE OR REPLACE FUNCTION public.pos_complete_sale_v2(
  p_shift_id uuid,
  p_operator_id uuid,
  p_client_op_id text,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_discount_snapshot jsonb DEFAULT '{}'::jsonb,
  p_benefit_snapshot jsonb DEFAULT '{}'::jsonb,
  p_authorization_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item record;
  v_sku public.inv_skus;
  v_subtotal numeric := 0;
  v_eligible numeric := 0;
  v_discount numeric := 0;
  v_payable numeric := 0;
  v_tender_total numeric := 0;
  v_discount_type text;
  v_discount_value numeric;
  v_discount_provider text;
  v_discount_transaction text := 'POS-DISCOUNT:' || p_client_op_id;
  v_augmented_tenders jsonb;
  v_result jsonb;
  v_order_id uuid;
  v_authorization public.pos_authorizations;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale requires at least one item';
  END IF;

  FOR v_item IN
    SELECT item.sku_id, item.quantity
      FROM jsonb_to_recordset(p_items) AS item(sku_id uuid, quantity integer)
  LOOP
    SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_item.sku_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'SKU % not found', v_item.sku_id; END IF;
    v_subtotal := v_subtotal + v_sku.price_tier * v_item.quantity;
    IF v_sku.discount_eligible AND v_sku.sale_ownership = 'owned' THEN
      v_eligible := v_eligible + v_sku.price_tier * v_item.quantity;
    END IF;
  END LOOP;

  v_discount_type := nullif(p_discount_snapshot->>'type', '');
  v_discount_value := coalesce((p_discount_snapshot->>'value')::numeric, 0);
  IF v_discount_type IS NULL THEN
    v_discount := 0;
  ELSIF v_discount_type = 'amount' THEN
    v_discount := v_discount_value;
  ELSIF v_discount_type = 'percentage' THEN
    IF v_discount_value < 0 OR v_discount_value > 100 THEN
      RAISE EXCEPTION 'percentage discount is invalid';
    END IF;
    v_discount := round(v_eligible * (1 - v_discount_value / 100), 2);
  ELSIF v_discount_type = 'final_price' THEN
    v_discount := v_subtotal - v_discount_value;
  ELSE
    RAISE EXCEPTION 'discount type is invalid';
  END IF;

  v_discount := round(v_discount, 2);
  IF v_discount < 0 OR v_discount > v_eligible THEN
    RAISE EXCEPTION 'discount exceeds eligible amount';
  END IF;
  v_payable := round(v_subtotal - v_discount, 2);

  SELECT coalesce(sum(tender.amount), 0)
    INTO v_tender_total
    FROM jsonb_to_recordset(p_tenders)
      AS tender(provider text, amount numeric, provider_transaction_id text);
  IF round(v_tender_total, 2) <> v_payable THEN
    RAISE EXCEPTION 'tender total does not match payable total';
  END IF;

  IF p_authorization_id IS NOT NULL THEN
    SELECT * INTO v_authorization
      FROM public.pos_authorizations
     WHERE id = p_authorization_id
       AND operator_id = p_operator_id
       AND status = 'approved'
       AND expires_at > now();
    IF NOT FOUND THEN RAISE EXCEPTION 'discount authorization is invalid'; END IF;
  END IF;

  v_augmented_tenders := p_tenders;
  IF v_discount > 0 THEN
    SELECT candidate.provider_name INTO v_discount_provider
      FROM unnest(ARRAY['manual','store_credit','bank_card','alipay','wechat','cash'])
        AS candidate(provider_name)
     WHERE NOT EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(p_tenders)
           AS tender(provider text, amount numeric, provider_transaction_id text)
        WHERE tender.provider = candidate.provider_name
     )
     LIMIT 1;
    IF v_discount_provider IS NULL THEN
      RAISE EXCEPTION 'too many tender providers';
    END IF;
    v_augmented_tenders := p_tenders || jsonb_build_array(jsonb_build_object(
      'provider', v_discount_provider,
      'amount', v_discount,
      'provider_transaction_id', v_discount_transaction
    ));
  END IF;

  v_result := public.pos_complete_sale(
    p_shift_id, p_operator_id, p_client_op_id, p_items, v_augmented_tenders,
    p_customer_id, p_note
  );
  v_order_id := (v_result->>'order_id')::uuid;

  IF v_discount > 0 THEN
    DELETE FROM public.commerce_payment_events
     WHERE provider_event_id = v_discount_transaction;
    DELETE FROM public.commerce_payments
     WHERE order_id = v_order_id
       AND provider_transaction_id = v_discount_transaction;
  END IF;

  UPDATE public.commerce_orders
     SET discount_total = v_discount,
         total_amount = v_payable,
         discount_snapshot = coalesce(p_discount_snapshot, '{}'::jsonb),
         benefit_snapshot = coalesce(p_benefit_snapshot, '{}'::jsonb),
         authorization_id = p_authorization_id,
         updated_at = now()
   WHERE id = v_order_id;

  UPDATE public.commerce_order_items item
     SET original_unit_price = item.unit_price,
         ownership_snapshot = sku.sale_ownership,
         discount_snapshot = jsonb_build_object(
           'eligible', sku.discount_eligible AND sku.sale_ownership = 'owned',
           'order_discount_total', v_discount
         )
    FROM public.inv_skus sku
   WHERE item.order_id = v_order_id
     AND item.sku_id = sku.id;

  UPDATE public.pos_receipts
     SET payload = payload || jsonb_build_object(
       'subtotal', v_subtotal,
       'discount_total', v_discount,
       'total_amount', v_payable,
       'customer_id', p_customer_id
     )
   WHERE order_id = v_order_id;

  RETURN v_result || jsonb_build_object(
    'subtotal', v_subtotal,
    'discount_total', v_discount,
    'total_amount', v_payable
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_complete_return(
  p_shift_id uuid,
  p_operator_id uuid,
  p_order_id uuid,
  p_client_op_id text,
  p_items jsonb,
  p_reason text,
  p_authorization_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shift public.pos_shifts;
  v_order public.commerce_orders;
  v_return public.pos_returns;
  v_request record;
  v_order_item public.commerce_order_items;
  v_sku public.inv_skus;
  v_returned_quantity integer;
  v_refund_total numeric := 0;
BEGIN
  SELECT * INTO v_return FROM public.pos_returns WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'return_id', v_return.id, 'refund_total', v_return.refund_total, 'replayed', true
    );
  END IF;

  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'open' OR v_shift.operator_id <> p_operator_id THEN
    RAISE EXCEPTION 'POS shift is not available';
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.source_channel <> 'pos' OR v_order.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'POS order is not returnable';
  END IF;
  IF v_order.sale_location_id <> v_shift.location_id THEN
    RAISE EXCEPTION 'order belongs to another location';
  END IF;

  INSERT INTO public.pos_returns(
    order_id, shift_id, location_id, operator_id, authorization_id,
    reason, status, client_op_id, completed_at
  ) VALUES (
    p_order_id, p_shift_id, v_shift.location_id, p_operator_id, p_authorization_id,
    p_reason, 'completed', p_client_op_id, now()
  ) RETURNING * INTO v_return;

  FOR v_request IN
    SELECT item.order_item_id, item.quantity
      FROM jsonb_to_recordset(p_items) AS item(order_item_id uuid, quantity integer)
  LOOP
    SELECT * INTO v_order_item
      FROM public.commerce_order_items
     WHERE id = v_request.order_item_id
       AND order_id = p_order_id;
    IF NOT FOUND OR v_request.quantity < 1 OR v_request.quantity > v_order_item.quantity THEN
      RAISE EXCEPTION 'return item quantity is invalid';
    END IF;

    SELECT COALESCE(sum(return_item.quantity), 0)::integer
      INTO v_returned_quantity
      FROM public.pos_return_items return_item
      JOIN public.pos_returns sale_return ON sale_return.id = return_item.return_id
     WHERE return_item.order_item_id = v_order_item.id
       AND sale_return.status IN ('pending', 'completed');
    IF v_returned_quantity + v_request.quantity > v_order_item.quantity THEN
      RAISE EXCEPTION 'return quantity exceeds remaining quantity';
    END IF;

    SELECT * INTO v_sku
      FROM public.inv_skus
     WHERE id = v_order_item.sku_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'return SKU not found';
    END IF;

    INSERT INTO public.pos_return_items(
      return_id, order_item_id, sku_id, quantity, refund_amount,
      physical_status, inspection_status
    ) VALUES (
      v_return.id, v_order_item.id, v_order_item.sku_id, v_request.quantity,
      round(v_order_item.line_total / v_order_item.quantity * v_request.quantity, 2),
      'received',
      CASE
        WHEN v_sku.kind = 'single'
         AND NOT v_sku.is_custom_price
         AND v_order_item.epc IS NULL
        THEN 'passed'
        ELSE 'pending'
      END
    );
    v_refund_total := v_refund_total
      + round(v_order_item.line_total / v_order_item.quantity * v_request.quantity, 2);

    IF v_sku.kind = 'single'
       AND NOT v_sku.is_custom_price
       AND v_order_item.epc IS NULL THEN
      PERFORM public.inv_apply_movement(
        v_order_item.sku_id, v_shift.location_id, v_request.quantity,
        'pos_return', v_return.id, NULL, p_client_op_id
      );
    END IF;
  END LOOP;

  UPDATE public.pos_returns SET refund_total = v_refund_total WHERE id = v_return.id;
  UPDATE public.commerce_orders
     SET order_status = 'after_sale',
         metadata = metadata || jsonb_build_object('latest_pos_return_id', v_return.id),
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'return_id', v_return.id,
    'refund_total', v_refund_total,
    'inspection_required', EXISTS (
      SELECT 1 FROM public.pos_return_items
       WHERE return_id = v_return.id AND inspection_status = 'pending'
    ),
    'replayed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_complete_sale_v2(
  uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_complete_return(
  uuid,uuid,uuid,text,jsonb,text,uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale_v2(
  uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_return(
  uuid,uuid,uuid,text,jsonb,text,uuid
) TO service_role;
