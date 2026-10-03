-- No conversion rate is assumed. Activation requires approved whole-point/whole-fen
-- units on a membership plan, its existing cap, and points_redemption_enabled=true.
-- Cash only: async payment requires a reservation lifecycle before it can be enabled.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';

-- A tombstone survives retries and prevents a timed-out sale from arriving later.
CREATE TABLE public.pos_sale_cancellations (
  client_op_id text PRIMARY KEY CHECK (btrim(client_op_id) <> ''),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id),
  operator_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  cancelled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pos_sale_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_sale_cancellations FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.commerce_membership_plans
  ADD COLUMN points_redemption_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN points_redemption_points_per_unit integer CHECK (points_redemption_points_per_unit > 0),
  ADD COLUMN points_redemption_unit_fen integer CHECK (points_redemption_unit_fen > 0),
  ADD CONSTRAINT points_redemption_requires_rule CHECK (
    NOT points_redemption_enabled OR
    (points_redemption_points_per_unit IS NOT NULL AND points_redemption_unit_fen IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public.pos_points_rules(p_customer_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH chosen AS (
    SELECT p.*, 0 AS priority, e.expires_at
      FROM public.commerce_membership_entitlements e
      JOIN public.commerce_membership_plans p ON p.id = e.plan_id
     WHERE e.customer_id = p_customer_id AND e.status = 'active'
       AND e.starts_at <= now() AND (e.expires_at IS NULL OR e.expires_at > now())
       AND p.is_active
    UNION ALL
    SELECT p.*, 1 AS priority, NULL::timestamptz
      FROM public.commerce_membership_plans p WHERE p.code = 'free' AND p.is_active
  ), best AS (
    SELECT * FROM chosen ORDER BY priority,
      CASE tier_code WHEN 'explorer' THEN 0 ELSE 1 END, expires_at DESC NULLS FIRST, id LIMIT 1
  )
  SELECT jsonb_build_object(
    'enabled', coalesce((SELECT points_redemption_enabled FROM best), false),
    'customer_active', EXISTS (SELECT 1 FROM public.commerce_customers WHERE id = p_customer_id AND status = 'active'),
    'available_points', coalesce((SELECT points FROM public.pos_customer_wallets WHERE customer_id = p_customer_id), 0),
    'cap_rate', coalesce((SELECT points_redemption_cap_rate FROM best), 0),
    'points_per_unit', (SELECT points_redemption_points_per_unit FROM best),
    'unit_fen', (SELECT points_redemption_unit_fen FROM best),
    'policy_version', (SELECT policy_version FROM best),
    'plan_code', (SELECT code FROM best)
  );
$$;

-- Preserve the existing stock/payment implementation behind service-only wrappers.
ALTER FUNCTION public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)
  RENAME TO pos_complete_sale_without_points;
REVOKE ALL ON FUNCTION public.pos_complete_sale_without_points(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
-- Runtime callers must use v2/v3; their SECURITY DEFINER owner can still call this core.
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid,uuid,text,jsonb,jsonb,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_complete_sale_v3(
  p_shift_id uuid, p_operator_id uuid, p_client_op_id text, p_items jsonb, p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL, p_note text DEFAULT NULL,
  p_discount_snapshot jsonb DEFAULT '{}'::jsonb, p_benefit_snapshot jsonb DEFAULT '{}'::jsonb,
  p_authorization_id uuid DEFAULT NULL, p_points_to_redeem integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.commerce_orders;
  v_shift public.pos_shifts;
  v_request jsonb;
  v_rules jsonb;
  v_result jsonb;
  v_snapshot jsonb;
  v_balance integer;
  v_subtotal numeric := 0;
  v_eligible numeric := 0;
  v_manual numeric := 0;
  v_value numeric;
  v_points_fen numeric;
  v_cap_fen numeric;
  v_points_unit integer;
  v_fen_unit integer;
  v_line record;
  v_running numeric := 0;
  v_prev_discount numeric := 0;
  v_next_discount numeric;
  v_prev_points integer := 0;
  v_next_points integer;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' THEN RAISE EXCEPTION 'client operation id required'; END IF;
  IF p_points_to_redeem IS NULL OR p_points_to_redeem < 0 THEN RAISE EXCEPTION 'points_request_invalid'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'sale_recovery_isolation_unsupported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || p_client_op_id, 0));
  IF EXISTS (SELECT 1 FROM public.pos_sale_cancellations WHERE client_op_id = p_client_op_id) THEN
    RAISE EXCEPTION 'sale_operation_cancelled';
  END IF;
  v_request := jsonb_build_object('shift_id', p_shift_id, 'operator_id', p_operator_id,
    'customer_id', p_customer_id, 'items', p_items, 'tenders', p_tenders,
    'discount', p_discount_snapshot, 'points', p_points_to_redeem);
  SELECT * INTO v_order FROM public.commerce_orders WHERE source_channel = 'pos' AND idempotency_key = p_client_op_id FOR UPDATE;
  IF FOUND THEN
    IF v_order.operator_id IS DISTINCT FROM p_operator_id OR v_order.pos_shift_id IS DISTINCT FROM p_shift_id
      OR v_order.customer_id IS DISTINCT FROM p_customer_id
      OR (v_order.metadata ? 'pos_sale_request' AND v_order.metadata->'pos_sale_request' IS DISTINCT FROM v_request)
      OR (NOT (v_order.metadata ? 'pos_sale_request') AND p_points_to_redeem <> 0) THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no,
      'replayed', true, 'subtotal', v_order.subtotal, 'discount_total', v_order.discount_total,
      'total_amount', v_order.total_amount, 'points_redemption', v_order.benefit_snapshot->'points_redemption');
  END IF;
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'open' OR v_shift.operator_id IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'POS shift is not available';
  END IF;

  IF p_points_to_redeem = 0 THEN
    v_result := public.pos_complete_sale_without_points(p_shift_id,p_operator_id,p_client_op_id,p_items,p_tenders,
      p_customer_id,p_note,p_discount_snapshot,coalesce(p_benefit_snapshot,'{}') - 'points_redemption',p_authorization_id);
    UPDATE public.commerce_orders SET metadata = metadata || jsonb_build_object('pos_sale_request',v_request)
      WHERE id = (v_result->>'order_id')::uuid;
    RETURN v_result;
  END IF;

  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'points_customer_required'; END IF;
  IF jsonb_typeof(p_tenders) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tenders) = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_tenders) t WHERE t->>'provider' IS DISTINCT FROM 'cash') THEN
    RAISE EXCEPTION 'points_async_not_supported';
  END IF;
  SELECT points INTO v_balance FROM public.pos_customer_wallets WHERE customer_id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_wallet_unavailable'; END IF;
  v_rules := public.pos_points_rules(p_customer_id);
  IF NOT (v_rules->>'customer_active')::boolean THEN RAISE EXCEPTION 'points_customer_inactive'; END IF;
  IF NOT (v_rules->>'enabled')::boolean THEN RAISE EXCEPTION 'points_rule_not_configured'; END IF;
  v_points_unit := (v_rules->>'points_per_unit')::integer;
  v_fen_unit := (v_rules->>'unit_fen')::integer;
  IF v_points_unit IS NULL OR v_fen_unit IS NULL OR v_points_unit <= 0 OR v_fen_unit <= 0 THEN
    RAISE EXCEPTION 'points_rule_not_configured';
  END IF;
  IF p_points_to_redeem > v_balance OR p_points_to_redeem % v_points_unit <> 0 THEN
    RAISE EXCEPTION 'points_balance_or_unit_invalid';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale requires items';
  END IF;
  -- Freeze prices/eligibility while both the quote and legacy stock transaction run.
  PERFORM 1 FROM public.inv_skus WHERE id IN
    (SELECT (item->>'sku_id')::uuid FROM jsonb_array_elements(p_items) item) ORDER BY id FOR UPDATE;
  SELECT sum(s.price_tier * i.quantity),
    coalesce(sum(s.price_tier * i.quantity) FILTER (WHERE s.discount_eligible AND s.sale_ownership = 'owned'),0)
    INTO v_subtotal, v_eligible FROM jsonb_to_recordset(p_items) i(sku_id uuid, quantity integer)
    JOIN public.inv_skus s ON s.id = i.sku_id;
  v_value := coalesce((p_discount_snapshot->>'value')::numeric,0);
  CASE coalesce(p_discount_snapshot->>'type','amount')
    WHEN 'amount' THEN v_manual := round(v_value,2);
    WHEN 'percentage' THEN
      IF v_value < 0 OR v_value > 100 THEN RAISE EXCEPTION 'discount value invalid'; END IF;
      v_manual := round(v_eligible * (1 - v_value / 100),2);
    WHEN 'final_price' THEN v_manual := round(v_subtotal - v_value,2);
    ELSE RAISE EXCEPTION 'discount type invalid';
  END CASE;
  IF v_manual < 0 OR v_manual > v_eligible THEN RAISE EXCEPTION 'discount exceeds eligible amount'; END IF;
  v_points_fen := (p_points_to_redeem / v_points_unit)::numeric * v_fen_unit;
  v_cap_fen := floor((v_eligible - v_manual) * 100 * (v_rules->>'cap_rate')::numeric);
  IF v_points_fen > v_cap_fen OR v_subtotal - v_manual - v_points_fen / 100 < 0.01 THEN
    RAISE EXCEPTION 'points_cap_exceeded';
  END IF;
  IF (v_manual + v_points_fen / 100 > 20 OR (v_manual + v_points_fen / 100) * 10 > v_eligible)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_operator_id
      AND role::text IN ('super_admin','hq_operator','store_manager')) THEN
    IF NOT EXISTS (SELECT 1 FROM public.pos_authorizations a
      WHERE a.id = p_authorization_id AND a.operator_id = p_operator_id
        AND a.location_id = v_shift.location_id AND a.action = 'order_discount'
        AND a.status = 'approved' AND a.expires_at > now()
        AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = a.authorizer_id
          AND r.role::text IN ('super_admin','hq_operator','store_manager'))) THEN
      RAISE EXCEPTION 'discount authorization required for combined points discount';
    END IF;
  END IF;
  v_snapshot := v_rules || jsonb_build_object('applied_points',p_points_to_redeem,
    'discount_amount',v_points_fen / 100,'cap_basis','eligible_after_discount');
  v_result := public.pos_complete_sale_without_points(p_shift_id,p_operator_id,p_client_op_id,p_items,p_tenders,
    p_customer_id,p_note,jsonb_build_object('type','amount','value',v_manual + v_points_fen / 100,
      'reason',p_discount_snapshot->>'reason'),
    (coalesce(p_benefit_snapshot,'{}') - 'points_redemption') || jsonb_build_object('points_redemption',v_snapshot),p_authorization_id);
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = (v_result->>'order_id')::uuid;
  UPDATE public.pos_customer_wallets SET points = points - p_points_to_redeem, updated_at = now()
    WHERE customer_id = p_customer_id RETURNING points INTO v_balance;
  INSERT INTO public.commerce_points_ledger(customer_id,delta,balance_after,source_type,source_id,idempotency_key,metadata)
    VALUES (p_customer_id,-p_points_to_redeem,v_balance,'pos_redemption',v_order.id::text,
      'pos-redemption:' || v_order.id,v_snapshot);
  UPDATE public.commerce_orders SET discount_snapshot = coalesce(p_discount_snapshot,'{}'),
    metadata = metadata || jsonb_build_object('pos_sale_request',v_request) WHERE id = v_order.id;

  -- Cumulative allocation conserves every fen and point, including the final line.
  FOR v_line IN SELECT * FROM public.commerce_order_items WHERE order_id = v_order.id ORDER BY id LOOP
    IF (v_line.discount_snapshot->>'eligible')::boolean THEN
      v_running := v_running + v_line.line_total;
      v_next_discount := floor((v_manual * 100 + v_points_fen) * v_running / v_eligible);
      v_next_points := floor(p_points_to_redeem::numeric * v_running / v_eligible);
      UPDATE public.commerce_order_items SET
        discount_total = (v_next_discount - v_prev_discount) / 100,
        line_total = line_total - (v_next_discount - v_prev_discount) / 100,
        discount_snapshot = discount_snapshot || jsonb_build_object('points_allocated',v_next_points - v_prev_points)
        WHERE id = v_line.id;
      v_prev_discount := v_next_discount;
      v_prev_points := v_next_points;
    END IF;
  END LOOP;
  UPDATE public.pos_receipts SET payload = payload || jsonb_build_object('points_redemption',v_snapshot,
    'items',(SELECT jsonb_agg(jsonb_build_object('sku_id',sku_id,'title',title_snapshot,
      'unit_price',unit_price,'quantity',quantity,'line_total',line_total,'discount_total',discount_total,
      'category_code',category_code,'category_name',category_name_snapshot,
      'subcategory_code',subcategory_code,'subcategory_name',subcategory_name_snapshot) ORDER BY created_at,id)
      FROM public.commerce_order_items WHERE order_id = v_order.id)) WHERE order_id = v_order.id;
  RETURN v_result || jsonb_build_object('points_redemption',v_snapshot,
    'items',(SELECT payload->'items' FROM public.pos_receipts WHERE order_id = v_order.id));
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_complete_sale_v2(
  p_shift_id uuid,p_operator_id uuid,p_client_op_id text,p_items jsonb,p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL,p_note text DEFAULT NULL,p_discount_snapshot jsonb DEFAULT '{}',
  p_benefit_snapshot jsonb DEFAULT '{}',p_authorization_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.pos_complete_sale_v3(p_shift_id,p_operator_id,p_client_op_id,p_items,p_tenders,
    p_customer_id,p_note,p_discount_snapshot,p_benefit_snapshot,p_authorization_id,0);
$$;

-- This resolves the operation, not the external tender. It never refunds a payment.
CREATE OR REPLACE FUNCTION public.pos_recover_sale_cancel(
  p_shift_id uuid, p_operator_id uuid, p_client_op_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shift public.pos_shifts;
  v_order public.commerce_orders;
  v_cancel public.pos_sale_cancellations;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' THEN RAISE EXCEPTION 'client operation id required'; END IF;
  -- A fresh post-lock snapshot is required when an in-flight sale wins the lock.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'sale_recovery_isolation_unsupported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || p_client_op_id, 0));
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shift_not_found'; END IF;
  IF v_shift.operator_id IS DISTINCT FROM p_operator_id THEN RAISE EXCEPTION 'shift_forbidden'; END IF;
  -- Closed shifts still need recovery; do not require an open shift here.
  SELECT * INTO v_order FROM public.commerce_orders
    WHERE source_channel = 'pos' AND idempotency_key = p_client_op_id FOR UPDATE;
  IF FOUND THEN
    IF v_order.operator_id IS DISTINCT FROM p_operator_id OR v_order.pos_shift_id IS DISTINCT FROM p_shift_id
      OR v_order.sale_location_id IS DISTINCT FROM v_shift.location_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('status','completed','client_op_id',p_client_op_id,
      'order',jsonb_build_object('order_id',v_order.id,'order_no',v_order.order_no,
        'subtotal',v_order.subtotal,'discount_total',v_order.discount_total,'total_amount',v_order.total_amount,
        'points_redemption',v_order.benefit_snapshot->'points_redemption'));
  END IF;
  SELECT * INTO v_cancel FROM public.pos_sale_cancellations WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_cancel.shift_id IS DISTINCT FROM p_shift_id OR v_cancel.operator_id IS DISTINCT FROM p_operator_id
      OR v_cancel.location_id IS DISTINCT FROM v_shift.location_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
  ELSE
    INSERT INTO public.pos_sale_cancellations(client_op_id,shift_id,operator_id,location_id)
      VALUES(p_client_op_id,p_shift_id,p_operator_id,v_shift.location_id);
  END IF;
  RETURN jsonb_build_object('status','cancelled','client_op_id',p_client_op_id,'order',NULL);
END;
$$;

ALTER FUNCTION public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid)
  RENAME TO pos_complete_return_without_points;
REVOKE ALL ON FUNCTION public.pos_complete_return_without_points(uuid,uuid,uuid,text,jsonb,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_complete_return(
  p_shift_id uuid,p_operator_id uuid,p_order_id uuid,p_client_op_id text,p_items jsonb,p_reason text,
  p_authorization_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.commerce_orders;
  v_return public.pos_returns;
  v_result jsonb;
  v_line record;
  v_previous integer;
  v_points integer := 0;
  v_line_points integer;
  v_refund numeric := 0;
  v_amount numeric;
  v_balance integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-return:' || p_client_op_id,0));
  SELECT * INTO v_return FROM public.pos_returns WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_return.order_id IS DISTINCT FROM p_order_id OR v_return.operator_id IS DISTINCT FROM p_operator_id
      OR v_return.shift_id IS DISTINCT FROM p_shift_id THEN RAISE EXCEPTION 'return idempotency_conflict'; END IF;
    RETURN jsonb_build_object('return_id',v_return.id,'refund_total',v_return.refund_total,'replayed',true,
      'points_restored',coalesce((SELECT delta FROM public.commerce_points_ledger WHERE idempotency_key = 'pos-return:' || v_return.id),0));
  END IF;
  -- Match the legacy shift -> order lock order, then serialize wallet mutations.
  PERFORM 1 FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS order is not returnable'; END IF;
  IF NOT (v_order.benefit_snapshot ? 'points_redemption') THEN
    RETURN public.pos_complete_return_without_points(p_shift_id,p_operator_id,p_order_id,p_client_op_id,p_items,p_reason,p_authorization_id);
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'return requires items';
  END IF;
  PERFORM 1 FROM public.pos_customer_wallets WHERE customer_id = v_order.customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_wallet_unavailable'; END IF;
  v_result := public.pos_complete_return_without_points(p_shift_id,p_operator_id,p_order_id,p_client_op_id,p_items,p_reason,p_authorization_id);
  FOR v_line IN SELECT ri.quantity AS returned_now,oi.*
    FROM public.pos_return_items ri JOIN public.commerce_order_items oi ON oi.id = ri.order_item_id
    WHERE ri.return_id = (v_result->>'return_id')::uuid
  LOOP
    SELECT coalesce(sum(ri.quantity),0) INTO v_previous FROM public.pos_return_items ri
      JOIN public.pos_returns r ON r.id = ri.return_id WHERE ri.order_item_id = v_line.id
      AND r.id <> (v_result->>'return_id')::uuid
      AND (r.status <> 'rejected' OR r.completed_at IS NOT NULL);
    -- A later administrative status change cannot reopen an already completed return.
    IF v_previous + v_line.returned_now > v_line.quantity THEN
      RAISE EXCEPTION 'return quantity exceeds remaining quantity';
    END IF;
    v_amount := (floor(v_line.line_total * 100 * (v_previous + v_line.returned_now) / v_line.quantity)
      - floor(v_line.line_total * 100 * v_previous / v_line.quantity)) / 100;
    v_line_points := coalesce((v_line.discount_snapshot->>'points_allocated')::integer,0);
    v_points := v_points + floor(v_line_points::numeric * (v_previous + v_line.returned_now) / v_line.quantity)::integer
      - floor(v_line_points::numeric * v_previous / v_line.quantity)::integer;
    UPDATE public.pos_return_items SET refund_amount = v_amount
      WHERE return_id = (v_result->>'return_id')::uuid AND order_item_id = v_line.id;
    v_refund := v_refund + v_amount;
  END LOOP;
  UPDATE public.pos_returns SET refund_total = v_refund WHERE id = (v_result->>'return_id')::uuid;
  IF v_points > 0 THEN
    UPDATE public.pos_customer_wallets SET points = points + v_points, updated_at = now()
      WHERE customer_id = v_order.customer_id RETURNING points INTO v_balance;
    INSERT INTO public.commerce_points_ledger(customer_id,delta,balance_after,source_type,source_id,idempotency_key)
      VALUES(v_order.customer_id,v_points,v_balance,'pos_redemption_refund',v_result->>'return_id',
        'pos-return:' || (v_result->>'return_id'));
  END IF;
  RETURN v_result || jsonb_build_object('refund_total',v_refund,'points_restored',v_points);
END;
$$;

REVOKE ALL ON FUNCTION public.pos_points_rules(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_recover_sale_cancel(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pos_points_rules(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_recover_sale_cancel(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid) TO service_role;

INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES ('20261002174301','pos_points_redemption',ARRAY[$pos_migration_source$-- No conversion rate is assumed. Activation requires approved whole-point/whole-fen
-- units on a membership plan, its existing cap, and points_redemption_enabled=true.
-- Cash only: async payment requires a reservation lifecycle before it can be enabled.
BEGIN;

-- A tombstone survives retries and prevents a timed-out sale from arriving later.
CREATE TABLE public.pos_sale_cancellations (
  client_op_id text PRIMARY KEY CHECK (btrim(client_op_id) <> ''),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id),
  operator_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  cancelled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pos_sale_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_sale_cancellations FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.commerce_membership_plans
  ADD COLUMN points_redemption_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN points_redemption_points_per_unit integer CHECK (points_redemption_points_per_unit > 0),
  ADD COLUMN points_redemption_unit_fen integer CHECK (points_redemption_unit_fen > 0),
  ADD CONSTRAINT points_redemption_requires_rule CHECK (
    NOT points_redemption_enabled OR
    (points_redemption_points_per_unit IS NOT NULL AND points_redemption_unit_fen IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public.pos_points_rules(p_customer_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH chosen AS (
    SELECT p.*, 0 AS priority, e.expires_at
      FROM public.commerce_membership_entitlements e
      JOIN public.commerce_membership_plans p ON p.id = e.plan_id
     WHERE e.customer_id = p_customer_id AND e.status = 'active'
       AND e.starts_at <= now() AND (e.expires_at IS NULL OR e.expires_at > now())
       AND p.is_active
    UNION ALL
    SELECT p.*, 1 AS priority, NULL::timestamptz
      FROM public.commerce_membership_plans p WHERE p.code = 'free' AND p.is_active
  ), best AS (
    SELECT * FROM chosen ORDER BY priority,
      CASE tier_code WHEN 'explorer' THEN 0 ELSE 1 END, expires_at DESC NULLS FIRST, id LIMIT 1
  )
  SELECT jsonb_build_object(
    'enabled', coalesce((SELECT points_redemption_enabled FROM best), false),
    'customer_active', EXISTS (SELECT 1 FROM public.commerce_customers WHERE id = p_customer_id AND status = 'active'),
    'available_points', coalesce((SELECT points FROM public.pos_customer_wallets WHERE customer_id = p_customer_id), 0),
    'cap_rate', coalesce((SELECT points_redemption_cap_rate FROM best), 0),
    'points_per_unit', (SELECT points_redemption_points_per_unit FROM best),
    'unit_fen', (SELECT points_redemption_unit_fen FROM best),
    'policy_version', (SELECT policy_version FROM best),
    'plan_code', (SELECT code FROM best)
  );
$$;

-- Preserve the existing stock/payment implementation behind service-only wrappers.
ALTER FUNCTION public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)
  RENAME TO pos_complete_sale_without_points;
REVOKE ALL ON FUNCTION public.pos_complete_sale_without_points(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
-- Runtime callers must use v2/v3; their SECURITY DEFINER owner can still call this core.
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid,uuid,text,jsonb,jsonb,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_complete_sale_v3(
  p_shift_id uuid, p_operator_id uuid, p_client_op_id text, p_items jsonb, p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL, p_note text DEFAULT NULL,
  p_discount_snapshot jsonb DEFAULT '{}'::jsonb, p_benefit_snapshot jsonb DEFAULT '{}'::jsonb,
  p_authorization_id uuid DEFAULT NULL, p_points_to_redeem integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.commerce_orders;
  v_shift public.pos_shifts;
  v_request jsonb;
  v_rules jsonb;
  v_result jsonb;
  v_snapshot jsonb;
  v_balance integer;
  v_subtotal numeric := 0;
  v_eligible numeric := 0;
  v_manual numeric := 0;
  v_value numeric;
  v_points_fen numeric;
  v_cap_fen numeric;
  v_points_unit integer;
  v_fen_unit integer;
  v_line record;
  v_running numeric := 0;
  v_prev_discount numeric := 0;
  v_next_discount numeric;
  v_prev_points integer := 0;
  v_next_points integer;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' THEN RAISE EXCEPTION 'client operation id required'; END IF;
  IF p_points_to_redeem IS NULL OR p_points_to_redeem < 0 THEN RAISE EXCEPTION 'points_request_invalid'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'sale_recovery_isolation_unsupported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || p_client_op_id, 0));
  IF EXISTS (SELECT 1 FROM public.pos_sale_cancellations WHERE client_op_id = p_client_op_id) THEN
    RAISE EXCEPTION 'sale_operation_cancelled';
  END IF;
  v_request := jsonb_build_object('shift_id', p_shift_id, 'operator_id', p_operator_id,
    'customer_id', p_customer_id, 'items', p_items, 'tenders', p_tenders,
    'discount', p_discount_snapshot, 'points', p_points_to_redeem);
  SELECT * INTO v_order FROM public.commerce_orders WHERE source_channel = 'pos' AND idempotency_key = p_client_op_id FOR UPDATE;
  IF FOUND THEN
    IF v_order.operator_id IS DISTINCT FROM p_operator_id OR v_order.pos_shift_id IS DISTINCT FROM p_shift_id
      OR v_order.customer_id IS DISTINCT FROM p_customer_id
      OR (v_order.metadata ? 'pos_sale_request' AND v_order.metadata->'pos_sale_request' IS DISTINCT FROM v_request)
      OR (NOT (v_order.metadata ? 'pos_sale_request') AND p_points_to_redeem <> 0) THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no,
      'replayed', true, 'subtotal', v_order.subtotal, 'discount_total', v_order.discount_total,
      'total_amount', v_order.total_amount, 'points_redemption', v_order.benefit_snapshot->'points_redemption');
  END IF;
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'open' OR v_shift.operator_id IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'POS shift is not available';
  END IF;

  IF p_points_to_redeem = 0 THEN
    v_result := public.pos_complete_sale_without_points(p_shift_id,p_operator_id,p_client_op_id,p_items,p_tenders,
      p_customer_id,p_note,p_discount_snapshot,coalesce(p_benefit_snapshot,'{}') - 'points_redemption',p_authorization_id);
    UPDATE public.commerce_orders SET metadata = metadata || jsonb_build_object('pos_sale_request',v_request)
      WHERE id = (v_result->>'order_id')::uuid;
    RETURN v_result;
  END IF;

  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'points_customer_required'; END IF;
  IF jsonb_typeof(p_tenders) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tenders) = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_tenders) t WHERE t->>'provider' IS DISTINCT FROM 'cash') THEN
    RAISE EXCEPTION 'points_async_not_supported';
  END IF;
  SELECT points INTO v_balance FROM public.pos_customer_wallets WHERE customer_id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_wallet_unavailable'; END IF;
  v_rules := public.pos_points_rules(p_customer_id);
  IF NOT (v_rules->>'customer_active')::boolean THEN RAISE EXCEPTION 'points_customer_inactive'; END IF;
  IF NOT (v_rules->>'enabled')::boolean THEN RAISE EXCEPTION 'points_rule_not_configured'; END IF;
  v_points_unit := (v_rules->>'points_per_unit')::integer;
  v_fen_unit := (v_rules->>'unit_fen')::integer;
  IF v_points_unit IS NULL OR v_fen_unit IS NULL OR v_points_unit <= 0 OR v_fen_unit <= 0 THEN
    RAISE EXCEPTION 'points_rule_not_configured';
  END IF;
  IF p_points_to_redeem > v_balance OR p_points_to_redeem % v_points_unit <> 0 THEN
    RAISE EXCEPTION 'points_balance_or_unit_invalid';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale requires items';
  END IF;
  -- Freeze prices/eligibility while both the quote and legacy stock transaction run.
  PERFORM 1 FROM public.inv_skus WHERE id IN
    (SELECT (item->>'sku_id')::uuid FROM jsonb_array_elements(p_items) item) ORDER BY id FOR UPDATE;
  SELECT sum(s.price_tier * i.quantity),
    coalesce(sum(s.price_tier * i.quantity) FILTER (WHERE s.discount_eligible AND s.sale_ownership = 'owned'),0)
    INTO v_subtotal, v_eligible FROM jsonb_to_recordset(p_items) i(sku_id uuid, quantity integer)
    JOIN public.inv_skus s ON s.id = i.sku_id;
  v_value := coalesce((p_discount_snapshot->>'value')::numeric,0);
  CASE coalesce(p_discount_snapshot->>'type','amount')
    WHEN 'amount' THEN v_manual := round(v_value,2);
    WHEN 'percentage' THEN
      IF v_value < 0 OR v_value > 100 THEN RAISE EXCEPTION 'discount value invalid'; END IF;
      v_manual := round(v_eligible * (1 - v_value / 100),2);
    WHEN 'final_price' THEN v_manual := round(v_subtotal - v_value,2);
    ELSE RAISE EXCEPTION 'discount type invalid';
  END CASE;
  IF v_manual < 0 OR v_manual > v_eligible THEN RAISE EXCEPTION 'discount exceeds eligible amount'; END IF;
  v_points_fen := (p_points_to_redeem / v_points_unit)::numeric * v_fen_unit;
  v_cap_fen := floor((v_eligible - v_manual) * 100 * (v_rules->>'cap_rate')::numeric);
  IF v_points_fen > v_cap_fen OR v_subtotal - v_manual - v_points_fen / 100 < 0.01 THEN
    RAISE EXCEPTION 'points_cap_exceeded';
  END IF;
  IF (v_manual + v_points_fen / 100 > 20 OR (v_manual + v_points_fen / 100) * 10 > v_eligible)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_operator_id
      AND role::text IN ('super_admin','hq_operator','store_manager')) THEN
    IF NOT EXISTS (SELECT 1 FROM public.pos_authorizations a
      WHERE a.id = p_authorization_id AND a.operator_id = p_operator_id
        AND a.location_id = v_shift.location_id AND a.action = 'order_discount'
        AND a.status = 'approved' AND a.expires_at > now()
        AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = a.authorizer_id
          AND r.role::text IN ('super_admin','hq_operator','store_manager'))) THEN
      RAISE EXCEPTION 'discount authorization required for combined points discount';
    END IF;
  END IF;
  v_snapshot := v_rules || jsonb_build_object('applied_points',p_points_to_redeem,
    'discount_amount',v_points_fen / 100,'cap_basis','eligible_after_discount');
  v_result := public.pos_complete_sale_without_points(p_shift_id,p_operator_id,p_client_op_id,p_items,p_tenders,
    p_customer_id,p_note,jsonb_build_object('type','amount','value',v_manual + v_points_fen / 100,
      'reason',p_discount_snapshot->>'reason'),
    (coalesce(p_benefit_snapshot,'{}') - 'points_redemption') || jsonb_build_object('points_redemption',v_snapshot),p_authorization_id);
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = (v_result->>'order_id')::uuid;
  UPDATE public.pos_customer_wallets SET points = points - p_points_to_redeem, updated_at = now()
    WHERE customer_id = p_customer_id RETURNING points INTO v_balance;
  INSERT INTO public.commerce_points_ledger(customer_id,delta,balance_after,source_type,source_id,idempotency_key,metadata)
    VALUES (p_customer_id,-p_points_to_redeem,v_balance,'pos_redemption',v_order.id::text,
      'pos-redemption:' || v_order.id,v_snapshot);
  UPDATE public.commerce_orders SET discount_snapshot = coalesce(p_discount_snapshot,'{}'),
    metadata = metadata || jsonb_build_object('pos_sale_request',v_request) WHERE id = v_order.id;

  -- Cumulative allocation conserves every fen and point, including the final line.
  FOR v_line IN SELECT * FROM public.commerce_order_items WHERE order_id = v_order.id ORDER BY id LOOP
    IF (v_line.discount_snapshot->>'eligible')::boolean THEN
      v_running := v_running + v_line.line_total;
      v_next_discount := floor((v_manual * 100 + v_points_fen) * v_running / v_eligible);
      v_next_points := floor(p_points_to_redeem::numeric * v_running / v_eligible);
      UPDATE public.commerce_order_items SET
        discount_total = (v_next_discount - v_prev_discount) / 100,
        line_total = line_total - (v_next_discount - v_prev_discount) / 100,
        discount_snapshot = discount_snapshot || jsonb_build_object('points_allocated',v_next_points - v_prev_points)
        WHERE id = v_line.id;
      v_prev_discount := v_next_discount;
      v_prev_points := v_next_points;
    END IF;
  END LOOP;
  UPDATE public.pos_receipts SET payload = payload || jsonb_build_object('points_redemption',v_snapshot,
    'items',(SELECT jsonb_agg(jsonb_build_object('sku_id',sku_id,'title',title_snapshot,
      'unit_price',unit_price,'quantity',quantity,'line_total',line_total,'discount_total',discount_total,
      'category_code',category_code,'category_name',category_name_snapshot,
      'subcategory_code',subcategory_code,'subcategory_name',subcategory_name_snapshot) ORDER BY created_at,id)
      FROM public.commerce_order_items WHERE order_id = v_order.id)) WHERE order_id = v_order.id;
  RETURN v_result || jsonb_build_object('points_redemption',v_snapshot,
    'items',(SELECT payload->'items' FROM public.pos_receipts WHERE order_id = v_order.id));
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_complete_sale_v2(
  p_shift_id uuid,p_operator_id uuid,p_client_op_id text,p_items jsonb,p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL,p_note text DEFAULT NULL,p_discount_snapshot jsonb DEFAULT '{}',
  p_benefit_snapshot jsonb DEFAULT '{}',p_authorization_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.pos_complete_sale_v3(p_shift_id,p_operator_id,p_client_op_id,p_items,p_tenders,
    p_customer_id,p_note,p_discount_snapshot,p_benefit_snapshot,p_authorization_id,0);
$$;

-- This resolves the operation, not the external tender. It never refunds a payment.
CREATE OR REPLACE FUNCTION public.pos_recover_sale_cancel(
  p_shift_id uuid, p_operator_id uuid, p_client_op_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shift public.pos_shifts;
  v_order public.commerce_orders;
  v_cancel public.pos_sale_cancellations;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' THEN RAISE EXCEPTION 'client operation id required'; END IF;
  -- A fresh post-lock snapshot is required when an in-flight sale wins the lock.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'sale_recovery_isolation_unsupported';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || p_client_op_id, 0));
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'shift_not_found'; END IF;
  IF v_shift.operator_id IS DISTINCT FROM p_operator_id THEN RAISE EXCEPTION 'shift_forbidden'; END IF;
  -- Closed shifts still need recovery; do not require an open shift here.
  SELECT * INTO v_order FROM public.commerce_orders
    WHERE source_channel = 'pos' AND idempotency_key = p_client_op_id FOR UPDATE;
  IF FOUND THEN
    IF v_order.operator_id IS DISTINCT FROM p_operator_id OR v_order.pos_shift_id IS DISTINCT FROM p_shift_id
      OR v_order.sale_location_id IS DISTINCT FROM v_shift.location_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('status','completed','client_op_id',p_client_op_id,
      'order',jsonb_build_object('order_id',v_order.id,'order_no',v_order.order_no,
        'subtotal',v_order.subtotal,'discount_total',v_order.discount_total,'total_amount',v_order.total_amount,
        'points_redemption',v_order.benefit_snapshot->'points_redemption'));
  END IF;
  SELECT * INTO v_cancel FROM public.pos_sale_cancellations WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_cancel.shift_id IS DISTINCT FROM p_shift_id OR v_cancel.operator_id IS DISTINCT FROM p_operator_id
      OR v_cancel.location_id IS DISTINCT FROM v_shift.location_id THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
  ELSE
    INSERT INTO public.pos_sale_cancellations(client_op_id,shift_id,operator_id,location_id)
      VALUES(p_client_op_id,p_shift_id,p_operator_id,v_shift.location_id);
  END IF;
  RETURN jsonb_build_object('status','cancelled','client_op_id',p_client_op_id,'order',NULL);
END;
$$;

ALTER FUNCTION public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid)
  RENAME TO pos_complete_return_without_points;
REVOKE ALL ON FUNCTION public.pos_complete_return_without_points(uuid,uuid,uuid,text,jsonb,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_complete_return(
  p_shift_id uuid,p_operator_id uuid,p_order_id uuid,p_client_op_id text,p_items jsonb,p_reason text,
  p_authorization_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.commerce_orders;
  v_return public.pos_returns;
  v_result jsonb;
  v_line record;
  v_previous integer;
  v_points integer := 0;
  v_line_points integer;
  v_refund numeric := 0;
  v_amount numeric;
  v_balance integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-return:' || p_client_op_id,0));
  SELECT * INTO v_return FROM public.pos_returns WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_return.order_id IS DISTINCT FROM p_order_id OR v_return.operator_id IS DISTINCT FROM p_operator_id
      OR v_return.shift_id IS DISTINCT FROM p_shift_id THEN RAISE EXCEPTION 'return idempotency_conflict'; END IF;
    RETURN jsonb_build_object('return_id',v_return.id,'refund_total',v_return.refund_total,'replayed',true,
      'points_restored',coalesce((SELECT delta FROM public.commerce_points_ledger WHERE idempotency_key = 'pos-return:' || v_return.id),0));
  END IF;
  -- Match the legacy shift -> order lock order, then serialize wallet mutations.
  PERFORM 1 FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS order is not returnable'; END IF;
  IF NOT (v_order.benefit_snapshot ? 'points_redemption') THEN
    RETURN public.pos_complete_return_without_points(p_shift_id,p_operator_id,p_order_id,p_client_op_id,p_items,p_reason,p_authorization_id);
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'return requires items';
  END IF;
  PERFORM 1 FROM public.pos_customer_wallets WHERE customer_id = v_order.customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_wallet_unavailable'; END IF;
  v_result := public.pos_complete_return_without_points(p_shift_id,p_operator_id,p_order_id,p_client_op_id,p_items,p_reason,p_authorization_id);
  FOR v_line IN SELECT ri.quantity AS returned_now,oi.*
    FROM public.pos_return_items ri JOIN public.commerce_order_items oi ON oi.id = ri.order_item_id
    WHERE ri.return_id = (v_result->>'return_id')::uuid
  LOOP
    SELECT coalesce(sum(ri.quantity),0) INTO v_previous FROM public.pos_return_items ri
      JOIN public.pos_returns r ON r.id = ri.return_id WHERE ri.order_item_id = v_line.id
      AND r.id <> (v_result->>'return_id')::uuid
      AND (r.status <> 'rejected' OR r.completed_at IS NOT NULL);
    -- A later administrative status change cannot reopen an already completed return.
    IF v_previous + v_line.returned_now > v_line.quantity THEN
      RAISE EXCEPTION 'return quantity exceeds remaining quantity';
    END IF;
    v_amount := (floor(v_line.line_total * 100 * (v_previous + v_line.returned_now) / v_line.quantity)
      - floor(v_line.line_total * 100 * v_previous / v_line.quantity)) / 100;
    v_line_points := coalesce((v_line.discount_snapshot->>'points_allocated')::integer,0);
    v_points := v_points + floor(v_line_points::numeric * (v_previous + v_line.returned_now) / v_line.quantity)::integer
      - floor(v_line_points::numeric * v_previous / v_line.quantity)::integer;
    UPDATE public.pos_return_items SET refund_amount = v_amount
      WHERE return_id = (v_result->>'return_id')::uuid AND order_item_id = v_line.id;
    v_refund := v_refund + v_amount;
  END LOOP;
  UPDATE public.pos_returns SET refund_total = v_refund WHERE id = (v_result->>'return_id')::uuid;
  IF v_points > 0 THEN
    UPDATE public.pos_customer_wallets SET points = points + v_points, updated_at = now()
      WHERE customer_id = v_order.customer_id RETURNING points INTO v_balance;
    INSERT INTO public.commerce_points_ledger(customer_id,delta,balance_after,source_type,source_id,idempotency_key)
      VALUES(v_order.customer_id,v_points,v_balance,'pos_redemption_refund',v_result->>'return_id',
        'pos-return:' || (v_result->>'return_id'));
  END IF;
  RETURN v_result || jsonb_build_object('refund_total',v_refund,'points_restored',v_points);
END;
$$;

REVOKE ALL ON FUNCTION public.pos_points_rules(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_recover_sale_cancel(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pos_points_rules(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_recover_sale_cancel(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid) TO service_role;
COMMIT;
$pos_migration_source$]);
NOTIFY pgrst, 'reload schema';
COMMIT;
