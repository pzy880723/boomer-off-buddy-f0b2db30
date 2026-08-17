-- BOOMER-OFF consumer membership source of truth.
-- The Flutter client and channel systems must read or mutate membership through ERP APIs.

CREATE TABLE public.commerce_membership_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  tier_code text NOT NULL CHECK (tier_code IN ('free', 'explorer')),
  display_name text NOT NULL,
  billing_period text NOT NULL CHECK (billing_period IN ('free', 'monthly', 'annual')),
  amount_fen integer NOT NULL DEFAULT 0 CHECK (amount_fen >= 0),
  first_period_amount_fen integer CHECK (first_period_amount_fen IS NULL OR first_period_amount_fen >= 0),
  renewal_amount_fen integer CHECK (renewal_amount_fen IS NULL OR renewal_amount_fen >= 0),
  daily_recognition_limit integer NOT NULL CHECK (daily_recognition_limit > 0),
  official_discount_rate numeric(6,4) NOT NULL DEFAULT 1.0000
    CHECK (official_discount_rate > 0 AND official_discount_rate <= 1),
  points_multiplier numeric(6,4) NOT NULL DEFAULT 1.0000
    CHECK (points_multiplier >= 1),
  points_redemption_cap_rate numeric(6,4) NOT NULL DEFAULT 0
    CHECK (points_redemption_cap_rate >= 0 AND points_redemption_cap_rate <= 1),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  benefit_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commerce_membership_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES public.commerce_membership_plans(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('apple', 'wechat', 'youzan', 'manual')),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created', 'pending', 'paid', 'entitlement_granted',
      'failed', 'cancelled', 'expired', 'refunded'
    )),
  amount_fen integer NOT NULL CHECK (amount_fen >= 0),
  currency text NOT NULL DEFAULT 'CNY',
  idempotency_key text NOT NULL,
  provider_transaction_id text,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  agreement_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at timestamptz,
  entitlement_applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);
CREATE UNIQUE INDEX commerce_membership_orders_provider_tx
  ON public.commerce_membership_orders(platform, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE public.commerce_membership_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES public.commerce_membership_plans(id) ON DELETE RESTRICT,
  source_order_id uuid REFERENCES public.commerce_membership_orders(id) ON DELETE SET NULL,
  tier_code text NOT NULL CHECK (tier_code IN ('free', 'explorer')),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'cancelled', 'refunded')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  auto_renew boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'erp',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX commerce_membership_entitlements_customer_active
  ON public.commerce_membership_entitlements(customer_id, status, expires_at DESC);

CREATE TABLE public.commerce_recognition_usage_daily (
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  tier_code text NOT NULL CHECK (tier_code IN ('free', 'explorer')),
  allowance integer NOT NULL CHECK (allowance > 0),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= allowance),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, usage_date)
);

CREATE TABLE public.commerce_recognition_usage_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  entitlement_id uuid REFERENCES public.commerce_membership_entitlements(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'released')),
  authorization_token_hash text,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  released_at timestamptz
);
CREATE INDEX commerce_recognition_requests_customer
  ON public.commerce_recognition_usage_requests(customer_id, usage_date, reserved_at DESC);

CREATE TABLE public.commerce_points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  delta integer NOT NULL CHECK (delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  source_type text NOT NULL,
  source_id text,
  idempotency_key text NOT NULL UNIQUE,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_points_ledger_customer
  ON public.commerce_points_ledger(customer_id, created_at DESC);

CREATE TABLE public.commerce_coupon_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  amount_fen integer NOT NULL CHECK (amount_fen > 0),
  minimum_spend_fen integer NOT NULL DEFAULT 0 CHECK (minimum_spend_fen >= 0),
  eligible_tiers text[] NOT NULL DEFAULT ARRAY['free', 'explorer'],
  issuance_kind text NOT NULL CHECK (issuance_kind IN ('newcomer', 'signup_pack', 'monthly', 'manual')),
  validity_days integer NOT NULL DEFAULT 90 CHECK (validity_days > 0),
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_customer_wallets
  ADD COLUMN IF NOT EXISTS membership_plan_code text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS entitlement_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS membership_policy_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.pos_customer_coupons
  ADD COLUMN IF NOT EXISTS definition_id uuid REFERENCES public.commerce_coupon_definitions(id),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'erp',
  ADD COLUMN IF NOT EXISTS external_provider text,
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX pos_customer_coupons_idempotency
  ON public.pos_customer_coupons(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX pos_customer_coupons_external
  ON public.pos_customer_coupons(external_provider, external_id)
  WHERE external_provider IS NOT NULL AND external_id IS NOT NULL;

CREATE TABLE public.commerce_member_code_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_location_id uuid REFERENCES public.inv_locations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_member_codes_customer_active
  ON public.commerce_member_code_sessions(customer_id, status, expires_at DESC);

CREATE TABLE public.commerce_consumption_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('erp_pos', 'storefront', 'youzan', 'manual')),
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE SET NULL,
  external_order_id text,
  location_id uuid REFERENCES public.inv_locations(id),
  gross_amount_fen integer NOT NULL DEFAULT 0 CHECK (gross_amount_fen >= 0),
  discount_amount_fen integer NOT NULL DEFAULT 0 CHECK (discount_amount_fen >= 0),
  points_discount_fen integer NOT NULL DEFAULT 0 CHECK (points_discount_fen >= 0),
  coupon_discount_fen integer NOT NULL DEFAULT 0 CHECK (coupon_discount_fen >= 0),
  paid_amount_fen integer NOT NULL DEFAULT 0 CHECK (paid_amount_fen >= 0),
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'refunded', 'cancelled')),
  idempotency_key text NOT NULL UNIQUE,
  benefit_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commerce_consumption_records_customer
  ON public.commerce_consumption_records(customer_id, occurred_at DESC);
CREATE UNIQUE INDEX commerce_consumption_records_channel_order
  ON public.commerce_consumption_records(channel, external_order_id)
  WHERE external_order_id IS NOT NULL;

INSERT INTO public.commerce_membership_plans (
  code, tier_code, display_name, billing_period, amount_fen,
  first_period_amount_fen, renewal_amount_fen, daily_recognition_limit,
  official_discount_rate, points_multiplier, points_redemption_cap_rate,
  policy_version, benefit_rules
) VALUES
  (
    'free', 'free', '好奇玩家', 'free', 0,
    NULL, NULL, 5,
    1.0000, 1.0000, 0.0000,
    1, '{"newcomer_coupon":"NEWCOMER_4990_500","personal_selling":false}'::jsonb
  ),
  (
    'explorer_monthly', 'explorer', '探索会员连续包月', 'monthly', 1990,
    990, 1990, 30,
    0.9500, 1.2000, 0.1500,
    1, '{"signup_coupon_pack_fen":10000,"monthly_coupon":true,"personal_selling":false}'::jsonb
  ),
  (
    'explorer_annual', 'explorer', '探索会员年度会员', 'annual', 9900,
    9900, 9900, 30,
    0.9500, 1.2000, 0.1500,
    1, '{"signup_coupon_pack_fen":10000,"monthly_coupon":true,"personal_selling":false}'::jsonb
  )
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  amount_fen = EXCLUDED.amount_fen,
  first_period_amount_fen = EXCLUDED.first_period_amount_fen,
  renewal_amount_fen = EXCLUDED.renewal_amount_fen,
  daily_recognition_limit = EXCLUDED.daily_recognition_limit,
  official_discount_rate = EXCLUDED.official_discount_rate,
  points_multiplier = EXCLUDED.points_multiplier,
  points_redemption_cap_rate = EXCLUDED.points_redemption_cap_rate,
  policy_version = EXCLUDED.policy_version,
  benefit_rules = EXCLUDED.benefit_rules,
  updated_at = now();

INSERT INTO public.commerce_coupon_definitions (
  code, name, amount_fen, minimum_spend_fen, eligible_tiers, issuance_kind, validity_days
) VALUES
  ('NEWCOMER_4990_500', '新人抵用券', 500, 4990, ARRAY['free', 'explorer'], 'newcomer', 90),
  ('EXPLORER_MONTHLY_500', '探索会员月度券', 500, 4990, ARRAY['explorer'], 'monthly', 30)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  amount_fen = EXCLUDED.amount_fen,
  minimum_spend_fen = EXCLUDED.minimum_spend_fen,
  eligible_tiers = EXCLUDED.eligible_tiers,
  issuance_kind = EXCLUDED.issuance_kind,
  validity_days = EXCLUDED.validity_days,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.commerce_reserve_recognition_quota(
  p_customer_id uuid,
  p_request_id text,
  p_usage_date date DEFAULT (timezone('Asia/Shanghai', now()))::date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entitlement_id uuid;
  v_tier_code text;
  v_allowance integer;
  v_policy_version integer;
  v_request_uuid uuid;
  v_existing_customer_id uuid;
  v_usage public.commerce_recognition_usage_daily%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION 'recognition request_id is required';
  END IF;

  SELECT entitlement.id, plan.tier_code, plan.daily_recognition_limit, plan.policy_version
    INTO v_entitlement_id, v_tier_code, v_allowance, v_policy_version
    FROM public.commerce_membership_entitlements entitlement
    JOIN public.commerce_membership_plans plan ON plan.id = entitlement.plan_id
   WHERE entitlement.customer_id = p_customer_id
     AND entitlement.status = 'active'
     AND entitlement.starts_at <= now()
     AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
     AND plan.is_active
   ORDER BY CASE plan.tier_code WHEN 'explorer' THEN 0 ELSE 1 END,
            entitlement.expires_at DESC NULLS FIRST
   LIMIT 1;

  IF v_tier_code IS NULL THEN
    SELECT tier_code, daily_recognition_limit, policy_version
      INTO v_tier_code, v_allowance, v_policy_version
      FROM public.commerce_membership_plans
     WHERE code = 'free' AND is_active
     LIMIT 1;
  END IF;

  IF v_tier_code IS NULL THEN
    RAISE EXCEPTION 'membership policy is unavailable';
  END IF;

  INSERT INTO public.commerce_recognition_usage_daily (
    customer_id, usage_date, tier_code, allowance, used, policy_version
  ) VALUES (
    p_customer_id, p_usage_date, v_tier_code, v_allowance, 0, v_policy_version
  )
  ON CONFLICT (customer_id, usage_date) DO NOTHING;

  INSERT INTO public.commerce_recognition_usage_requests (
    request_id, customer_id, usage_date, entitlement_id
  ) VALUES (
    p_request_id, p_customer_id, p_usage_date, v_entitlement_id
  )
  ON CONFLICT (request_id) DO NOTHING
  RETURNING id INTO v_request_uuid;

  IF v_request_uuid IS NULL THEN
    SELECT customer_id INTO v_existing_customer_id
      FROM public.commerce_recognition_usage_requests
     WHERE request_id = p_request_id;
    IF v_existing_customer_id IS DISTINCT FROM p_customer_id THEN
      RAISE EXCEPTION 'recognition request_id belongs to another customer';
    END IF;
    SELECT * INTO v_usage
      FROM public.commerce_recognition_usage_daily
     WHERE customer_id = p_customer_id AND usage_date = p_usage_date;
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'tier_code', v_usage.tier_code,
      'allowance', v_usage.allowance,
      'used', v_usage.used,
      'remaining', greatest(v_usage.allowance - v_usage.used, 0),
      'usage_date', v_usage.usage_date
    );
  END IF;

  SELECT * INTO v_usage
    FROM public.commerce_recognition_usage_daily
   WHERE customer_id = p_customer_id AND usage_date = p_usage_date
   FOR UPDATE;

  IF v_allowance > v_usage.allowance THEN
    UPDATE public.commerce_recognition_usage_daily
       SET tier_code = v_tier_code,
           allowance = v_allowance,
           policy_version = v_policy_version,
           updated_at = now()
     WHERE customer_id = p_customer_id AND usage_date = p_usage_date
     RETURNING * INTO v_usage;
  END IF;

  IF v_usage.used >= v_usage.allowance THEN
    RAISE EXCEPTION 'daily recognition quota exhausted';
  END IF;

  UPDATE public.commerce_recognition_usage_daily
     SET used = used + 1, updated_at = now()
   WHERE customer_id = p_customer_id AND usage_date = p_usage_date
   RETURNING * INTO v_usage;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'tier_code', v_usage.tier_code,
    'allowance', v_usage.allowance,
    'used', v_usage.used,
    'remaining', v_usage.allowance - v_usage.used,
    'usage_date', v_usage.usage_date
  );
END;
$$;

ALTER TABLE public.commerce_membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_membership_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_membership_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_recognition_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_recognition_usage_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_coupon_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_member_code_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_consumption_records ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.commerce_membership_plans TO service_role;
GRANT ALL ON public.commerce_membership_orders TO service_role;
GRANT ALL ON public.commerce_membership_entitlements TO service_role;
GRANT ALL ON public.commerce_recognition_usage_daily TO service_role;
GRANT ALL ON public.commerce_recognition_usage_requests TO service_role;
GRANT ALL ON public.commerce_points_ledger TO service_role;
GRANT ALL ON public.commerce_coupon_definitions TO service_role;
GRANT ALL ON public.commerce_member_code_sessions TO service_role;
GRANT ALL ON public.commerce_consumption_records TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_reserve_recognition_quota(uuid, text, date)
  TO service_role;