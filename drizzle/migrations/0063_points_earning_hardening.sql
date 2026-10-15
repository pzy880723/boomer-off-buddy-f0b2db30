-- Hardening for 0062: conflicting paid replays reject, append-only settlement audit, explicit revokes.
CREATE TABLE public.commerce_points_earning_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  earning_order_id uuid NOT NULL REFERENCES public.commerce_points_earning_orders(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  order_version integer NOT NULL,
  target_points integer NOT NULL,
  delta integer NOT NULL CHECK (delta <> 0),
  points_delta integer NOT NULL,
  debt_delta integer NOT NULL,
  points_before integer NOT NULL, points_after integer NOT NULL CHECK (points_after >= 0),
  debt_before integer NOT NULL, debt_after integer NOT NULL CHECK (debt_after >= 0),
  goods_refund_fen bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (earning_order_id, order_version),
  CHECK (points_delta - debt_delta = delta)
);
CREATE OR REPLACE FUNCTION public.commerce_points_earning_settlements_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'points_settlement_append_only'; END $$;
CREATE TRIGGER commerce_points_earning_settlements_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.commerce_points_earning_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION public.commerce_points_earning_settlements_immutable();

REVOKE ALL ON public.commerce_points_earning_orders, public.commerce_points_earning_order_keys,
  public.commerce_points_earning_refunds, public.commerce_points_earning_settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.commerce_points_earning_settlements TO service_role;
ALTER TABLE public.commerce_points_earning_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION public.commerce_points_earning_settlements_immutable() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.commerce_points_earning_settle(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.commerce_points_earning_orders; v_refund bigint; v_target integer; v_delta integer;
  w public.pos_customer_wallets; v_repay integer; v_points_delta integer; v_debt_delta integer;
BEGIN
  SELECT * INTO o FROM commerce_points_earning_orders WHERE id = p_order_id FOR UPDATE;
  SELECT coalesce(sum(goods_refund_fen), 0) INTO v_refund FROM commerce_points_earning_refunds WHERE earning_order_id = o.id;
  v_target := CASE WHEN o.status = 'earning'
    THEN (greatest(0, o.goods_paid_fen - v_refund) / 100)::integer ELSE 0 END;
  IF o.status IN ('hold','awaiting_paid') THEN v_target := o.granted_points; END IF;
  v_delta := v_target - o.granted_points;
  IF v_delta = 0 THEN RETURN jsonb_build_object('status', o.status, 'delta', 0, 'granted_points', o.granted_points); END IF;
  INSERT INTO pos_customer_wallets(customer_id) VALUES (o.customer_id) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM pos_customer_wallets WHERE customer_id = o.customer_id FOR UPDATE;
  IF v_delta > 0 THEN
    v_repay := least(w.points_debt, v_delta);
    v_points_delta := v_delta - v_repay; v_debt_delta := -v_repay;
  ELSE
    v_points_delta := -least(w.points, -v_delta); v_debt_delta := -v_delta + v_points_delta;
  END IF;
  UPDATE pos_customer_wallets SET points = points + v_points_delta, points_debt = points_debt + v_debt_delta,
    updated_at = now() WHERE customer_id = o.customer_id;
  UPDATE commerce_points_earning_orders SET granted_points = v_target, version = version + 1, updated_at = now()
    WHERE id = o.id;
  INSERT INTO commerce_points_earning_settlements(earning_order_id, customer_id, order_version, target_points, delta,
    points_delta, debt_delta, points_before, points_after, debt_before, debt_after, goods_refund_fen)
  VALUES (o.id, o.customer_id, o.version + 1, v_target, v_delta, v_points_delta, v_debt_delta,
    w.points, w.points + v_points_delta, w.points_debt, w.points_debt + v_debt_delta, v_refund);
  IF v_points_delta <> 0 THEN
    INSERT INTO commerce_points_ledger(customer_id, delta, balance_after, source_type, source_id, idempotency_key, description, metadata)
    VALUES (o.customer_id, v_points_delta, w.points + v_points_delta,
      CASE WHEN v_points_delta > 0 THEN 'order_earn' ELSE 'order_earn_reversal' END, o.canonical_key,
      'points_earn:' || o.id || ':v' || (o.version + 1), NULL,
      jsonb_build_object('rule_version', o.rule_version, 'target_points', v_target, 'debt_delta', v_debt_delta,
        'goods_paid_fen', o.goods_paid_fen, 'goods_refund_fen', v_refund));
  END IF;
  RETURN jsonb_build_object('status', o.status, 'delta', v_delta, 'points_delta', v_points_delta,
    'debt_delta', v_debt_delta, 'granted_points', v_target);
END $$;

CREATE OR REPLACE FUNCTION public.commerce_points_record_order_paid(
  p_canonical_key text, p_alias_keys text[], p_customer_id uuid, p_source text, p_goods_paid_fen bigint,
  p_discount_detail_complete boolean, p_points_coupon_used boolean, p_paid_at timestamptz, p_rule_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.commerce_points_earning_orders; v_status text; v_reason text;
BEGIN
  IF NOT commerce_points_earning_enabled() THEN RETURN jsonb_build_object('status', 'disabled'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('erp','youzan') OR p_customer_id IS NULL
    OR p_goods_paid_fen IS NULL OR p_goods_paid_fen < 0
    OR p_paid_at IS NULL OR coalesce(p_rule_version, '') = '' THEN RAISE EXCEPTION 'points_paid_fact_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customers WHERE id = p_customer_id AND status = 'active') THEN
    RAISE EXCEPTION 'points_customer_inactive';
  END IF;
  o := commerce_points_earning_lock_order(p_canonical_key, p_alias_keys);
  IF o.customer_id IS NOT NULL AND o.customer_id <> p_customer_id THEN RAISE EXCEPTION 'points_customer_mismatch'; END IF;
  IF o.status IN ('earning','zero_points_coupon') THEN
    -- Authoritative fact is frozen. Source may differ (alias of the same order); every other field must match.
    IF p_goods_paid_fen IS DISTINCT FROM o.goods_paid_fen OR p_paid_at IS DISTINCT FROM o.paid_at
      OR p_rule_version IS DISTINCT FROM o.rule_version OR p_discount_detail_complete IS NOT TRUE
      OR p_points_coupon_used IS DISTINCT FROM (o.status = 'zero_points_coupon') THEN
      RAISE EXCEPTION 'points_paid_fact_conflict';
    END IF;
    RETURN jsonb_build_object('status', o.status, 'duplicate', true, 'granted_points', o.granted_points);
  END IF;
  IF p_discount_detail_complete IS NOT TRUE OR p_points_coupon_used IS NULL THEN
    v_status := 'hold'; v_reason := 'discount_detail_incomplete';
  ELSIF p_points_coupon_used THEN v_status := 'zero_points_coupon';
  ELSE v_status := 'earning'; END IF;
  UPDATE commerce_points_earning_orders SET customer_id = p_customer_id, source = p_source, status = v_status,
    hold_reason = v_reason, goods_paid_fen = p_goods_paid_fen, paid_at = p_paid_at, rule_version = p_rule_version,
    updated_at = now() WHERE id = o.id;
  RETURN commerce_points_earning_settle(o.id) || jsonb_build_object('duplicate', false);
END $$;
REVOKE ALL ON FUNCTION public.commerce_points_earning_settle(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_points_record_order_paid(text, text[], uuid, text, bigint, boolean, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_points_record_order_paid(text, text[], uuid, text, bigint, boolean, boolean, timestamptz, text) TO service_role;
