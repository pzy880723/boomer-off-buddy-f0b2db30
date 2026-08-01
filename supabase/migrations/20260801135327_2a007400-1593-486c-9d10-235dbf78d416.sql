-- Store-scoped payment subjects for BOOMER OFF self-operated stores.
-- Provider secrets and certificates deliberately stay in the server secret manager.

CREATE TABLE public.payment_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_code text NOT NULL UNIQUE DEFAULT (
    'BO-SUB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  subject_type text NOT NULL CHECK (subject_type IN ('enterprise', 'individual_business')),
  legal_name text NOT NULL,
  unified_social_credit_code text NOT NULL UNIQUE,
  legal_representative_name text NOT NULL,
  contact_name text NOT NULL,
  contact_phone text NOT NULL,
  business_license_storage_path text,
  erp_verification_status text NOT NULL DEFAULT 'draft' CHECK (
    erp_verification_status IN ('draft', 'pending', 'approved', 'rejected')
  ),
  erp_verification_note text,
  verified_by uuid,
  verified_at timestamptz,
  provider_application_status text NOT NULL DEFAULT 'not_applied' CHECK (
    provider_application_status IN ('not_applied', 'applying', 'active', 'rejected', 'suspended')
  ),
  provider_application_id text,
  wechat_sub_mchid text UNIQUE,
  wechat_appid text,
  provider_status_note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_subject_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL REFERENCES public.payment_subjects(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'wechat' CHECK (provider IN ('wechat')),
  status text NOT NULL CHECK (
    status IN ('draft', 'submitted', 'reviewing', 'approved', 'rejected', 'suspended')
  ),
  provider_application_id text,
  application_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  submitted_by uuid,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.store_payment_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL UNIQUE REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  subject_id uuid REFERENCES public.payment_subjects(id),
  payment_code text NOT NULL UNIQUE DEFAULT (
    'BO-PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  channel text NOT NULL DEFAULT 'wechat' CHECK (channel IN ('wechat')),
  qr_mode text NOT NULL DEFAULT 'dynamic_order' CHECK (qr_mode IN ('dynamic_order')),
  status text NOT NULL DEFAULT 'setup_required' CHECK (
    status IN ('setup_required', 'pending', 'active', 'disabled')
  ),
  is_enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.store_payment_profiles (location_id)
SELECT location.id
  FROM public.inv_locations location
 WHERE location.kind = 'shop'
   AND location.is_active
ON CONFLICT (location_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_store_payment_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'shop' AND NEW.is_active THEN
    INSERT INTO public.store_payment_profiles(location_id)
    VALUES (NEW.id)
    ON CONFLICT (location_id) DO UPDATE SET is_enabled = true;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.store_payment_profiles
       SET is_enabled = false
     WHERE location_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ensure_store_payment_profile
  AFTER INSERT OR UPDATE OF kind, is_active ON public.inv_locations
  FOR EACH ROW EXECUTE FUNCTION public.ensure_store_payment_profile();

ALTER TABLE public.commerce_order_items
  ADD COLUMN IF NOT EXISTS settlement_subject_id uuid REFERENCES public.payment_subjects(id),
  ADD COLUMN IF NOT EXISTS settlement_snapshot jsonb;

ALTER TABLE public.commerce_payments
  ADD COLUMN IF NOT EXISTS payment_profile_id uuid REFERENCES public.store_payment_profiles(id),
  ADD COLUMN IF NOT EXISTS merchant_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE public.commerce_payment_suborders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.commerce_payments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  payment_profile_id uuid NOT NULL REFERENCES public.store_payment_profiles(id),
  settlement_subject_id uuid NOT NULL REFERENCES public.payment_subjects(id),
  provider text NOT NULL DEFAULT 'wechat' CHECK (provider IN ('wechat')),
  merchant_id_snapshot text NOT NULL,
  payment_code_snapshot text NOT NULL,
  line_amount numeric(12,2) NOT NULL CHECK (line_amount >= 0),
  order_adjustment numeric(12,2) NOT NULL DEFAULT 0,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled', 'refunded')
  ),
  provider_suborder_id text,
  allocation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, payment_profile_id)
);

CREATE INDEX idx_payment_subjects_status
  ON public.payment_subjects(erp_verification_status, provider_application_status);
CREATE INDEX idx_payment_subject_applications_subject
  ON public.payment_subject_applications(subject_id, created_at DESC);
CREATE INDEX idx_store_payment_profiles_subject
  ON public.store_payment_profiles(subject_id);
CREATE INDEX idx_commerce_order_items_settlement_subject
  ON public.commerce_order_items(settlement_subject_id);
CREATE INDEX idx_commerce_payment_suborders_order
  ON public.commerce_payment_suborders(order_id, created_at DESC);

CREATE TRIGGER trg_payment_subjects_updated
  BEFORE UPDATE ON public.payment_subjects
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_store_payment_profiles_updated
  BEFORE UPDATE ON public.store_payment_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_commerce_payment_suborders_updated
  BEFORE UPDATE ON public.commerce_payment_suborders
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.payment_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_subject_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_payment_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_payment_suborders ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_subjects FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_subject_applications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.store_payment_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.commerce_payment_suborders FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.payment_subjects TO service_role;
GRANT ALL ON public.payment_subject_applications TO service_role;
GRANT ALL ON public.store_payment_profiles TO service_role;
GRANT ALL ON public.commerce_payment_suborders TO service_role;

COMMENT ON TABLE public.payment_subjects IS
  'ERP-verified legal entities. WeChat APIv3 keys and certificates must remain in the server secret manager.';
COMMENT ON COLUMN public.store_payment_profiles.payment_code IS
  'Stable ERP store payment identity; each checkout still creates an order-specific dynamic QR code.';
COMMENT ON COLUMN public.commerce_order_items.settlement_snapshot IS
  'Immutable store, subject, merchant, and amount facts captured before payment.';

CREATE OR REPLACE FUNCTION public.commerce_capture_payment_allocation(
  p_order_id uuid,
  p_payment_id uuid,
  p_item_snapshots jsonb,
  p_suborders jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item record;
  v_suborder record;
BEGIN
  IF jsonb_typeof(p_item_snapshots) <> 'array' OR jsonb_typeof(p_suborders) <> 'array' THEN
    RAISE EXCEPTION 'payment allocation payload must be arrays';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.commerce_payments
     WHERE id = p_payment_id AND order_id = p_order_id
  ) THEN
    RAISE EXCEPTION 'payment does not belong to order';
  END IF;

  FOR v_item IN
    SELECT * FROM jsonb_to_recordset(p_item_snapshots)
      AS item(order_item_id uuid, settlement_subject_id uuid, snapshot jsonb)
  LOOP
    UPDATE public.commerce_order_items
       SET settlement_subject_id = v_item.settlement_subject_id,
           settlement_snapshot = v_item.snapshot
     WHERE id = v_item.order_item_id
       AND order_id = p_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'order item does not belong to order'; END IF;
  END LOOP;

  FOR v_suborder IN
    SELECT * FROM jsonb_to_recordset(p_suborders) AS child(
      payment_profile_id uuid,
      settlement_subject_id uuid,
      merchant_id text,
      payment_code text,
      line_amount numeric,
      order_adjustment numeric,
      amount numeric,
      currency text,
      location_ids jsonb
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM public.store_payment_profiles profile
        JOIN public.payment_subjects subject ON subject.id = profile.subject_id
       WHERE profile.id = v_suborder.payment_profile_id
         AND profile.subject_id = v_suborder.settlement_subject_id
         AND profile.status = 'active'
         AND profile.is_enabled
         AND subject.erp_verification_status = 'approved'
         AND subject.provider_application_status = 'active'
         AND subject.wechat_sub_mchid = v_suborder.merchant_id
    ) THEN
      RAISE EXCEPTION 'store payment profile is no longer active';
    END IF;

    INSERT INTO public.commerce_payment_suborders (
      payment_id, order_id, payment_profile_id, settlement_subject_id,
      provider, merchant_id_snapshot, payment_code_snapshot,
      line_amount, order_adjustment, amount, currency, allocation_snapshot
    ) VALUES (
      p_payment_id, p_order_id, v_suborder.payment_profile_id,
      v_suborder.settlement_subject_id, 'wechat', v_suborder.merchant_id,
      v_suborder.payment_code, v_suborder.line_amount, v_suborder.order_adjustment,
      v_suborder.amount, coalesce(v_suborder.currency, 'CNY'),
      jsonb_build_object('location_ids', v_suborder.location_ids)
    );
  END LOOP;

  UPDATE public.commerce_payments
     SET merchant_snapshot = jsonb_build_object('sub_orders', p_suborders),
         payment_profile_id = CASE
           WHEN jsonb_array_length(p_suborders) = 1
           THEN (p_suborders->0->>'payment_profile_id')::uuid
           ELSE NULL
         END,
         updated_at = now()
   WHERE id = p_payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.commerce_capture_payment_allocation(uuid,uuid,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_capture_payment_allocation(uuid,uuid,jsonb,jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.ensure_store_payment_profile()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_store_payment_profile()
  TO service_role;