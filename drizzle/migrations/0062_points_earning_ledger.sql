-- Phase 1: ERP-only points earning ledger adapter. Disabled by default; no backfill, no existing-balance change.
ALTER TABLE public.pos_customer_wallets
  ADD COLUMN IF NOT EXISTS points_debt integer NOT NULL DEFAULT 0 CHECK (points_debt >= 0);
COMMENT ON COLUMN public.pos_customer_wallets.points_debt IS
  'Earned points clawed back by refunds after they were already spent; repaid before any new earning.';

CREATE TABLE public.commerce_points_earning_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL UNIQUE CHECK (canonical_key ~ '^(erp|youzan):[A-Za-z0-9_.:-]{1,120}$'),
  customer_id uuid REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  source text CHECK (source IN ('erp','youzan')),
  status text NOT NULL DEFAULT 'awaiting_paid'
    CHECK (status IN ('awaiting_paid','hold','earning','zero_points_coupon')),
  hold_reason text,
  goods_paid_fen bigint CHECK (goods_paid_fen >= 0),
  rule_version text,
  granted_points integer NOT NULL DEFAULT 0 CHECK (granted_points >= 0),
  version integer NOT NULL DEFAULT 0,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.commerce_points_earning_order_keys (
  order_key text PRIMARY KEY,
  earning_order_id uuid NOT NULL REFERENCES public.commerce_points_earning_orders(id) ON DELETE RESTRICT
);
CREATE TABLE public.commerce_points_earning_refunds (
  refund_key text PRIMARY KEY CHECK (length(refund_key) BETWEEN 1 AND 160),
  earning_order_id uuid NOT NULL REFERENCES public.commerce_points_earning_orders(id) ON DELETE RESTRICT,
  goods_refund_fen bigint NOT NULL CHECK (goods_refund_fen > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.commerce_points_earning_orders, public.commerce_points_earning_order_keys,
  public.commerce_points_earning_refunds TO service_role;
ALTER TABLE public.commerce_points_earning_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_points_earning_order_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_points_earning_refunds ENABLE ROW LEVEL SECURITY;

-- Internal: resolve/create the order row for a key set under sorted advisory locks, then row-lock it.
CREATE OR REPLACE FUNCTION public.commerce_points_earning_lock_order(p_canonical_key text, p_alias_keys text[])
RETURNS public.commerce_points_earning_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_keys text[]; v_key text; v_ids uuid[]; v_row public.commerce_points_earning_orders;
BEGIN
  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys
    FROM unnest(array_prepend(p_canonical_key, coalesce(p_alias_keys, '{}'))) k WHERE k IS NOT NULL;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF v_key !~ '^(erp|youzan):[A-Za-z0-9_.:-]{1,120}$' THEN RAISE EXCEPTION 'points_order_key_invalid'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('points_earn:' || v_key, 0));
  END LOOP;
  SELECT array_agg(DISTINCT earning_order_id) INTO v_ids
    FROM commerce_points_earning_order_keys WHERE order_key = ANY(v_keys);
  IF coalesce(array_length(v_ids, 1), 0) > 1 THEN RAISE EXCEPTION 'points_order_alias_conflict'; END IF;
  IF v_ids IS NULL THEN
    INSERT INTO commerce_points_earning_orders(canonical_key) VALUES (p_canonical_key) RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM commerce_points_earning_orders WHERE id = v_ids[1] FOR UPDATE;
  END IF;
  INSERT INTO commerce_points_earning_order_keys(order_key, earning_order_id)
    SELECT k, v_row.id FROM unnest(v_keys) k ON CONFLICT (order_key) DO NOTHING;
  RETURN v_row;
END $$;

-- Internal: move granted points to the target, locking the wallet; spent points become debt.
CREATE OR REPLACE FUNCTION public.commerce_points_earning_settle(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.commerce_points_earning_orders; v_refund bigint; v_target integer; v_delta integer;
  w public.pos_customer_wallets; v_repay integer; v_points_delta integer; v_debt_delta integer;
BEGIN
  SELECT * INTO o FROM commerce_points_earning_orders WHERE id = p_order_id FOR UPDATE;
  SELECT coalesce(sum(goods_refund_fen), 0) INTO v_refund FROM commerce_points_earning_refunds WHERE earning_order_id = o.id;
  v_target := CASE WHEN o.status = 'earning'
    THEN (greatest(0, o.goods_paid_fen - v_refund) / 100)::integer ELSE 0 END;
  -- Hold/awaiting keep what was already granted until a trusted fact proves otherwise.
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

CREATE OR REPLACE FUNCTION public.commerce_points_earning_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT value = 'true'::jsonb FROM app_settings WHERE key = 'points_earning_enabled'), false)
$$;

-- Trusted adapter entry: one authoritative paid fact. Replays and concurrent calls converge on one grant.
CREATE OR REPLACE FUNCTION public.commerce_points_record_order_paid(
  p_canonical_key text, p_alias_keys text[], p_customer_id uuid, p_source text, p_goods_paid_fen bigint,
  p_discount_detail_complete boolean, p_points_coupon_used boolean, p_paid_at timestamptz, p_rule_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.commerce_points_earning_orders; v_status text; v_reason text;
BEGIN
  IF NOT commerce_points_earning_enabled() THEN RETURN jsonb_build_object('status', 'disabled'); END IF;
  IF p_source NOT IN ('erp','youzan') OR p_goods_paid_fen IS NULL OR p_goods_paid_fen < 0
    OR p_paid_at IS NULL OR coalesce(p_rule_version, '') = '' THEN RAISE EXCEPTION 'points_paid_fact_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customers WHERE id = p_customer_id AND status = 'active') THEN
    RAISE EXCEPTION 'points_customer_inactive';
  END IF;
  o := commerce_points_earning_lock_order(p_canonical_key, p_alias_keys);
  IF o.customer_id IS NOT NULL AND o.customer_id <> p_customer_id THEN RAISE EXCEPTION 'points_customer_mismatch'; END IF;
  IF o.status IN ('earning','zero_points_coupon') THEN
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

-- Trusted adapter entry: one refund fact (goods portion). Refunds may arrive before the paid fact.
CREATE OR REPLACE FUNCTION public.commerce_points_record_order_refund(
  p_canonical_key text, p_alias_keys text[], p_refund_key text, p_goods_refund_fen bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.commerce_points_earning_orders; v_inserted integer;
BEGIN
  IF NOT commerce_points_earning_enabled() THEN RETURN jsonb_build_object('status', 'disabled'); END IF;
  IF p_goods_refund_fen IS NULL OR p_goods_refund_fen <= 0 THEN RAISE EXCEPTION 'points_refund_fact_invalid'; END IF;
  o := commerce_points_earning_lock_order(p_canonical_key, p_alias_keys);
  INSERT INTO commerce_points_earning_refunds(refund_key, earning_order_id, goods_refund_fen)
    VALUES (p_refund_key, o.id, p_goods_refund_fen) ON CONFLICT (refund_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    IF NOT EXISTS (SELECT 1 FROM commerce_points_earning_refunds WHERE refund_key = p_refund_key
      AND earning_order_id = o.id AND goods_refund_fen = p_goods_refund_fen) THEN
      RAISE EXCEPTION 'points_refund_key_conflict';
    END IF;
    RETURN jsonb_build_object('status', o.status, 'duplicate', true, 'granted_points', o.granted_points);
  END IF;
  IF o.status = 'awaiting_paid' THEN RETURN jsonb_build_object('status', 'awaiting_paid', 'duplicate', false); END IF;
  RETURN commerce_points_earning_settle(o.id) || jsonb_build_object('duplicate', false);
END $$;

REVOKE ALL ON FUNCTION public.commerce_points_earning_lock_order(text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_points_earning_settle(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_points_earning_enabled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_points_record_order_paid(text, text[], uuid, text, bigint, boolean, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_points_record_order_refund(text, text[], text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_points_record_order_paid(text, text[], uuid, text, bigint, boolean, boolean, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_points_record_order_refund(text, text[], text, bigint) TO service_role;
