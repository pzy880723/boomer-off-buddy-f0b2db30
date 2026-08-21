-- Audited ERP membership operations. All mutations are performed through one
-- service-role-only RPC so the business ledger and audit row share a transaction.

CREATE TABLE public.commerce_membership_admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('entitlement', 'points', 'coupon')),
  before_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 2),
  reference text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX commerce_membership_admin_audit_customer_idx
  ON public.commerce_membership_admin_audit_logs(customer_id, created_at DESC);
CREATE INDEX commerce_membership_admin_audit_operator_idx
  ON public.commerce_membership_admin_audit_logs(operator_id, created_at DESC);

ALTER TABLE public.commerce_membership_admin_audit_logs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.commerce_membership_admin_audit_logs TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_admin_adjust_membership(
  p_operator_id uuid,
  p_customer_id uuid,
  p_action text,
  p_payload jsonb,
  p_reason text,
  p_reference text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_audit public.commerce_membership_admin_audit_logs%ROWTYPE;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_plan public.commerce_membership_plans%ROWTYPE;
  v_delta integer;
  v_balance integer;
  v_definition public.commerce_coupon_definitions%ROWTYPE;
  v_expires_at timestamptz;
  v_coupon_id uuid;
  v_audit_id uuid;
BEGIN
  IF p_operator_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'operator_id and customer_id are required';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 2 THEN
    RAISE EXCEPTION 'reason is required';
  END IF;
  IF p_action NOT IN ('entitlement', 'points', 'coupon') THEN
    RAISE EXCEPTION 'unsupported membership adjustment action';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commerce_customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'membership customer not found';
  END IF;

  SELECT * INTO v_existing_audit
  FROM public.commerce_membership_admin_audit_logs
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'audit_id', v_existing_audit.id,
      'duplicate', true,
      'after_value', v_existing_audit.after_value
    );
  END IF;

  IF p_action = 'entitlement' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb)
      INTO v_before
      FROM public.commerce_membership_entitlements e
     WHERE e.customer_id = p_customer_id AND e.status = 'active';

    SELECT * INTO v_plan
      FROM public.commerce_membership_plans
     WHERE code = NULLIF(p_payload->>'plan_code', '') AND is_active
     LIMIT 1;
    IF v_plan.id IS NULL THEN RAISE EXCEPTION 'membership plan not found'; END IF;

    UPDATE public.commerce_membership_entitlements
       SET status = 'cancelled', updated_at = now()
     WHERE customer_id = p_customer_id AND status = 'active';

    IF v_plan.tier_code = 'explorer' THEN
      v_expires_at := NULLIF(p_payload->>'expires_at', '')::timestamptz;
      IF v_expires_at IS NULL OR v_expires_at <= now() THEN
        RAISE EXCEPTION 'future expires_at is required for paid membership';
      END IF;
      INSERT INTO public.commerce_membership_entitlements (
        customer_id, plan_id, tier_code, policy_version, status,
        starts_at, expires_at, auto_renew, source
      ) VALUES (
        p_customer_id, v_plan.id, v_plan.tier_code, v_plan.policy_version, 'active',
        now(), v_expires_at, COALESCE((p_payload->>'auto_renew')::boolean, false), 'erp_admin'
      );
    END IF;

    INSERT INTO public.pos_customer_wallets (
      customer_id, membership_plan_code, entitlement_expires_at,
      membership_policy_version, member_level, updated_at
    ) VALUES (
      p_customer_id, v_plan.code, v_expires_at, v_plan.policy_version,
      CASE WHEN v_plan.tier_code = 'explorer' THEN '探索会员' ELSE '好奇玩家' END, now()
    )
    ON CONFLICT (customer_id) DO UPDATE SET
      membership_plan_code = EXCLUDED.membership_plan_code,
      entitlement_expires_at = EXCLUDED.entitlement_expires_at,
      membership_policy_version = EXCLUDED.membership_policy_version,
      member_level = EXCLUDED.member_level,
      updated_at = now();

    v_after := jsonb_build_object(
      'plan_code', v_plan.code,
      'tier_code', v_plan.tier_code,
      'expires_at', v_expires_at,
      'auto_renew', COALESCE((p_payload->>'auto_renew')::boolean, false)
    );

  ELSIF p_action = 'points' THEN
    v_delta := COALESCE((p_payload->>'delta')::integer, 0);
    IF v_delta = 0 THEN RAISE EXCEPTION 'non-zero points delta is required'; END IF;

    SELECT COALESCE(points, 0) INTO v_balance
      FROM public.pos_customer_wallets WHERE customer_id = p_customer_id FOR UPDATE;
    IF NOT FOUND THEN v_balance := 0; END IF;
    v_before := jsonb_build_object('points', v_balance);
    IF v_balance + v_delta < 0 THEN RAISE EXCEPTION 'insufficient points balance'; END IF;

    INSERT INTO public.pos_customer_wallets (customer_id, points, updated_at)
      VALUES (p_customer_id, v_balance + v_delta, now())
    ON CONFLICT (customer_id) DO UPDATE SET points = EXCLUDED.points, updated_at = now();

    INSERT INTO public.commerce_points_ledger (
      customer_id, delta, balance_after, source_type, source_id,
      idempotency_key, description, metadata
    ) VALUES (
      p_customer_id, v_delta, v_balance + v_delta, 'erp_admin', p_reference,
      'admin-points:' || p_idempotency_key, btrim(p_reason),
      jsonb_build_object('operator_id', p_operator_id)
    );
    v_after := jsonb_build_object('points', v_balance + v_delta, 'delta', v_delta);

  ELSE
    SELECT * INTO v_definition
      FROM public.commerce_coupon_definitions
     WHERE code = NULLIF(p_payload->>'definition_code', '') AND is_active
     LIMIT 1;
    IF v_definition.id IS NULL THEN RAISE EXCEPTION 'coupon definition not found'; END IF;

    v_before := jsonb_build_object(
      'active_coupon_count', (SELECT count(*) FROM public.pos_customer_coupons
        WHERE customer_id = p_customer_id AND status = 'active')
    );
    INSERT INTO public.pos_customer_coupons (
      customer_id, code, name, discount_type, value, min_spend,
      status, starts_at, expires_at, definition_id, source, idempotency_key, metadata
    ) VALUES (
      p_customer_id,
      'MANUAL-' || upper(substr(md5(p_idempotency_key), 1, 16)),
      v_definition.name, 'amount', v_definition.amount_fen / 100.0,
      v_definition.minimum_spend_fen / 100.0, 'active', now(),
      now() + make_interval(days => v_definition.validity_days),
      v_definition.id, 'erp_admin', 'admin-coupon:' || p_idempotency_key,
      jsonb_build_object('operator_id', p_operator_id, 'reason', btrim(p_reason))
    ) RETURNING id INTO v_coupon_id;
    v_after := jsonb_build_object(
      'coupon_id', v_coupon_id,
      'definition_code', v_definition.code,
      'amount_fen', v_definition.amount_fen,
      'minimum_spend_fen', v_definition.minimum_spend_fen
    );
  END IF;

  INSERT INTO public.commerce_membership_admin_audit_logs (
    operator_id, customer_id, action, before_value, after_value,
    reason, reference, idempotency_key
  ) VALUES (
    p_operator_id, p_customer_id, p_action, v_before, v_after,
    btrim(p_reason), NULLIF(btrim(p_reference), ''), p_idempotency_key
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object('audit_id', v_audit_id, 'duplicate', false, 'after_value', v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_admin_adjust_membership(
  uuid, uuid, text, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_admin_adjust_membership(
  uuid, uuid, text, jsonb, text, text, text
) TO service_role;
