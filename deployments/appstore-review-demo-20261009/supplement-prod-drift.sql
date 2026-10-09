-- Structures that exist in production but are created by NO file in supabase/migrations or drizzle/migrations.
-- Definitions copied read-only from the production catalog on 2026-10-09 (structure only, no rows).
-- For the App Store review DEMO instance only. Idempotent.

-- 1) inv_categories.shipping_fragile (used by commerce_quote_store_shipping)
ALTER TABLE public.inv_categories ADD COLUMN IF NOT EXISTS shipping_fragile boolean NOT NULL DEFAULT false;

-- 2) pos_customer_coupons store scope + reservation
ALTER TABLE public.pos_customer_coupons
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.inv_locations(id),
  ADD COLUMN IF NOT EXISTS reserved_order_id uuid REFERENCES public.commerce_orders(id);
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_customer_coupons_scope_check') THEN
    ALTER TABLE public.pos_customer_coupons ADD CONSTRAINT pos_customer_coupons_scope_check
      CHECK (scope = ANY (ARRAY['platform'::text, 'store'::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupon_location_scope') THEN
    ALTER TABLE public.pos_customer_coupons ADD CONSTRAINT coupon_location_scope
      CHECK (((scope = 'platform'::text) AND (location_id IS NULL)) OR ((scope = 'store'::text) AND (location_id IS NOT NULL)));
  END IF;
END $c$;
ALTER TABLE public.pos_customer_coupons DROP CONSTRAINT IF EXISTS pos_customer_coupons_status_check;
ALTER TABLE public.pos_customer_coupons ADD CONSTRAINT pos_customer_coupons_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'reserved'::text, 'used'::text, 'expired'::text, 'void'::text]));

-- 3) commerce_membership_admin_audit_logs (service-role only; RLS on, no policies)
CREATE TABLE IF NOT EXISTS public.commerce_membership_admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action = ANY (ARRAY['entitlement'::text, 'points'::text, 'coupon'::text])),
  before_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 2),
  reference text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commerce_membership_admin_audit_customer_idx
  ON public.commerce_membership_admin_audit_logs (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commerce_membership_admin_audit_operator_idx
  ON public.commerce_membership_admin_audit_logs (operator_id, created_at DESC);
REVOKE ALL ON public.commerce_membership_admin_audit_logs FROM anon, authenticated;
GRANT ALL ON public.commerce_membership_admin_audit_logs TO service_role;
ALTER TABLE public.commerce_membership_admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- 4) Functions + triggers
CREATE OR REPLACE FUNCTION public.commerce_admin_adjust_membership(p_operator_id uuid, p_customer_id uuid, p_action text, p_payload jsonb, p_reason text, p_reference text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.commerce_guard_reserved_coupon()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_order public.commerce_orders;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='reserved' THEN RAISE EXCEPTION 'reserved coupon cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status='reserved' THEN
    SELECT * INTO v_order FROM public.commerce_orders WHERE id=OLD.reserved_order_id;
    IF (to_jsonb(NEW)-ARRAY['status','updated_at','reserved_order_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','updated_at','reserved_order_id'])
      OR ((NEW.status='reserved' AND NEW.reserved_order_id=OLD.reserved_order_id)
        OR (NEW.status='used' AND v_order.payment_status IN ('paid','partially_refunded','refunded') AND NEW.reserved_order_id=OLD.reserved_order_id)
        OR (NEW.status IN ('active','expired') AND NEW.reserved_order_id IS NULL AND v_order.payment_status='unpaid' AND v_order.order_status IN ('cancelled','closed'))) IS NOT TRUE THEN
      RAISE EXCEPTION 'reserved coupon cannot be changed before order resolution';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.commerce_quote_store_shipping(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_lines jsonb; v_groups jsonb; v_subtotal bigint; v_shipping bigint;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid items'; END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid items count'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) i WHERE jsonb_typeof(i) IS DISTINCT FROM 'object'
    OR coalesce(i->>'listing_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(i->'quantity') IS DISTINCT FROM 'number' OR coalesce(i->>'quantity','') !~ '^[0-9]{1,3}$') THEN
    RAISE EXCEPTION 'invalid items or quantity';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) i WHERE (i->>'quantity')::int NOT BETWEEN 1 AND 999) THEN
    RAISE EXCEPTION 'invalid quantity';
  END IF;
  IF (SELECT count(DISTINCT (i->>'listing_id')::uuid) FROM jsonb_array_elements(p_items) i)<>jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'duplicate items';
  END IF;
  WITH RECURSIVE fragile AS (
    SELECT id FROM public.inv_categories WHERE shipping_fragile
    UNION
    SELECT c.id FROM public.inv_categories c JOIN fragile f ON c.parent_id=f.id
  ), lines AS (
    SELECT l.id AS listing_id, l.location_id, loc.name AS store_name, (i->>'quantity')::int AS quantity,
      (l.price*100)::bigint AS unit_price_fen,
      EXISTS(SELECT 1 FROM fragile f JOIN public.inv_categories c ON c.id=f.id
        WHERE c.id::text=to_jsonb(s)->>'category_id' OR (to_jsonb(s)->>'category_id' IS NULL AND (c.name=s.category OR to_jsonb(c)->>'code'=s.category))) AS fragile
    FROM jsonb_array_elements(p_items) i
    JOIN public.commerce_listings l ON l.id=(i->>'listing_id')::uuid
    JOIN public.inv_skus s ON s.id=l.sku_id
    JOIN public.inv_locations loc ON loc.id=l.location_id
    WHERE l.status='published' AND s.status='active' AND s.is_display AND loc.is_active AND l.price>=0
  )
  SELECT jsonb_agg(to_jsonb(lines) ORDER BY listing_id) INTO v_lines FROM lines;
  IF coalesce(jsonb_array_length(v_lines),0)<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'item not available'; END IF;
  SELECT sum((i->>'unit_price_fen')::bigint*(i->>'quantity')::int) INTO v_subtotal FROM jsonb_array_elements(v_lines) i;
  SELECT jsonb_agg(jsonb_build_object('location_id',location_id,'store_name',store_name,
    'subtotal_fen',subtotal,'shipping_fee_fen',CASE WHEN subtotal>=9900 OR v_subtotal>=29900 THEN 0 ELSE 990 END,
    'remaining_fen',CASE WHEN v_subtotal>=29900 THEN 0 ELSE greatest(9900-subtotal,0) END,'fragile',fragile) ORDER BY location_id),
    sum(CASE WHEN subtotal>=9900 OR v_subtotal>=29900 THEN 0 ELSE 990 END)
  INTO v_groups,v_shipping
  FROM (SELECT i->>'location_id' AS location_id, max(i->>'store_name') AS store_name,
    sum((i->>'unit_price_fen')::bigint*(i->>'quantity')::int)::bigint AS subtotal,
    bool_or((i->>'fragile')::boolean) AS fragile FROM jsonb_array_elements(v_lines) i GROUP BY i->>'location_id') grouped;
  RETURN jsonb_build_object('version','per_store_99_cross_299_v1','items',v_lines,'groups',v_groups,
    'cross_store_free',jsonb_array_length(v_groups)>1 AND v_subtotal>=29900,
    'cross_store_remaining_fen',CASE WHEN jsonb_array_length(v_groups)>1 THEN greatest(29900-v_subtotal,0) ELSE 0 END,
    'subtotal_fen',v_subtotal,'shipping_fee_fen',v_shipping,'total_fen',v_subtotal+v_shipping);
END;
$function$;

CREATE OR REPLACE FUNCTION public.commerce_storefront_coupon_options(p_customer_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_quote jsonb; v_options jsonb;
BEGIN
  v_quote:=public.commerce_quote_store_shipping(p_items);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'scope',scope,'location_id',location_id,
    'minimum_spend_fen',(min_spend*100)::bigint,'discount_fen',least((value*100)::bigint,eligible),
    'expires_at',expires_at) ORDER BY least((value*100)::bigint,eligible) DESC,expires_at NULLS LAST,id),'[]'::jsonb)
  INTO v_options FROM (
    SELECT c.*,CASE WHEN c.scope='platform' THEN (v_quote->>'subtotal_fen')::bigint ELSE
      coalesce((SELECT (g->>'subtotal_fen')::bigint FROM jsonb_array_elements(v_quote->'groups') g WHERE g->>'location_id'=c.location_id::text),0) END AS eligible
    FROM public.pos_customer_coupons c WHERE c.customer_id=p_customer_id AND c.status='active'
      AND c.discount_type='amount' AND nullif(c.external_provider,'') IS NULL
      AND (c.starts_at IS NULL OR c.starts_at<=now()) AND (c.expires_at IS NULL OR c.expires_at>now())
  ) eligible_coupons WHERE eligible>0 AND eligible>=min_spend*100;
  RETURN v_options;
END;
$function$;

CREATE OR REPLACE FUNCTION public.commerce_quote_checkout(p_customer_id uuid, p_items jsonb, p_coupon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_quote jsonb; v_coupon jsonb; v_discount bigint:=0; v_allocations jsonb;
BEGIN
  v_quote:=public.commerce_quote_store_shipping(p_items);
  IF p_coupon_id IS NOT NULL THEN
    SELECT c INTO v_coupon FROM jsonb_array_elements(public.commerce_storefront_coupon_options(p_customer_id,p_items)) c WHERE c->>'id'=p_coupon_id::text;
    IF v_coupon IS NULL THEN RAISE EXCEPTION 'coupon unavailable'; END IF;
    v_discount:=(v_coupon->>'discount_fen')::bigint;
  END IF;
  -- Proportional line allocations, cumulative rounding conserves every fen.
  WITH lines AS (
    SELECT i->>'listing_id' AS listing_id,i->>'location_id' AS location_id,
      (i->>'unit_price_fen')::bigint*(i->>'quantity')::int AS gross,
      CASE WHEN v_coupon->>'scope'='platform' OR v_coupon->>'location_id'=i->>'location_id'
        THEN (i->>'unit_price_fen')::bigint*(i->>'quantity')::int ELSE 0 END AS eligible
    FROM jsonb_array_elements(v_quote->'items') i
  ), running AS (
    SELECT *,sum(eligible) OVER(ORDER BY listing_id) AS cumulative,sum(eligible) OVER() AS eligible_total FROM lines
  ) SELECT jsonb_agg(jsonb_build_object('listing_id',listing_id,'location_id',location_id,'gross_fen',gross,
      'discount_fen',CASE WHEN eligible_total>0 THEN
        floor(v_discount::numeric*cumulative/eligible_total)-floor(v_discount::numeric*(cumulative-eligible)/eligible_total) ELSE 0 END)
      ORDER BY listing_id) INTO v_allocations FROM running;
  RETURN v_quote||jsonb_build_object('coupon',v_coupon,'discount_fen',v_discount,'discount_allocations',v_allocations,
    'total_fen',(v_quote->>'total_fen')::bigint-v_discount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.commerce_resolve_order_coupon()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.payment_status IN ('paid','partially_refunded','refunded') THEN
    UPDATE public.pos_customer_coupons SET status='used',updated_at=now() WHERE reserved_order_id=NEW.id AND status='reserved';
  ELSIF NEW.payment_status='unpaid' AND NEW.order_status IN ('cancelled','closed') THEN
    UPDATE public.pos_customer_coupons SET status=CASE WHEN expires_at IS NOT NULL AND expires_at<=now() THEN 'expired' ELSE 'active' END,
      reserved_order_id=NULL,updated_at=now() WHERE reserved_order_id=NEW.id AND status='reserved';
  END IF;
  RETURN NEW;
END;
$function$;

-- Same EXECUTE grants as production: owner + service_role only.
DO $g$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.commerce_admin_adjust_membership(uuid,uuid,text,jsonb,text,text,text)',
    'public.commerce_guard_reserved_coupon()', 'public.commerce_quote_store_shipping(jsonb)',
    'public.commerce_storefront_coupon_options(uuid,jsonb)', 'public.commerce_quote_checkout(uuid,jsonb,uuid)',
    'public.commerce_resolve_order_coupon()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $g$;

DROP TRIGGER IF EXISTS commerce_reserved_coupon_guard ON public.pos_customer_coupons;
CREATE TRIGGER commerce_reserved_coupon_guard BEFORE DELETE OR UPDATE ON public.pos_customer_coupons
  FOR EACH ROW EXECUTE FUNCTION public.commerce_guard_reserved_coupon();
DROP TRIGGER IF EXISTS commerce_order_coupon_resolution ON public.commerce_orders;
CREATE TRIGGER commerce_order_coupon_resolution AFTER UPDATE OF payment_status, order_status ON public.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION public.commerce_resolve_order_coupon();
