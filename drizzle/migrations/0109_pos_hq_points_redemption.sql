-- POS HQ points redemption: frozen intents bound to the existing Youzan HQ points ledger (0032).
-- Never reads or writes pos_customer_wallets / commerce_points_ledger. All objects are service_role only.

-- 1) Ledger send markers: a sent or unknown operation is reconciled read-only, never re-sent.
ALTER TABLE public.youzan_points_operations
  ADD COLUMN IF NOT EXISTS remote_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS reconcile_evidence jsonb;
ALTER TABLE public.youzan_points_operations DROP CONSTRAINT IF EXISTS youzan_points_operations_resolution_check;
ALTER TABLE public.youzan_points_operations ADD CONSTRAINT youzan_points_operations_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('not_sent','remote_matched_reconciled','remote_absent_reconciled'));
COMMENT ON COLUMN public.youzan_points_operations.remote_sent_at IS 'Set under claim fencing immediately before the remote write; once set the operation is never sent again.';
COMMENT ON COLUMN public.youzan_points_operations.resolution IS 'not_sent: blocked before any remote call; remote_*_reconciled: settled by official changelog evidence.';

CREATE OR REPLACE FUNCTION public.youzan_points_operation_begin(p_operation_key text, p_customer_id uuid, p_kdt_id bigint, p_source_kdt_id bigint, p_yz_open_id text, p_kind text, p_points integer, p_parent_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_row youzan_points_operations; v_parent youzan_points_operations; v_refunded bigint;
  v_src record; v_head record;
BEGIN
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9:_-]{8,128}$'
     OR p_customer_id IS NULL OR p_kdt_id IS NULL OR p_kdt_id <= 0 OR p_source_kdt_id IS NULL OR p_source_kdt_id <= 0
     OR p_yz_open_id IS NULL OR length(p_yz_open_id) NOT BETWEEN 1 AND 128
     OR p_kind IS NULL OR p_kind NOT IN ('debit','refund') OR p_points IS NULL OR p_points <= 0 OR p_points > 100000000 THEN
    RAISE EXCEPTION 'invalid_operation' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('yzpts:c:' || p_kdt_id || ':' || p_customer_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('yzpts:y:' || p_kdt_id || ':' || p_yz_open_id, 0));
  SELECT * INTO v_row FROM youzan_points_operations WHERE kdt_id = p_kdt_id AND operation_key = p_operation_key;
  IF FOUND THEN
    IF v_row.customer_id = p_customer_id AND v_row.source_kdt_id = p_source_kdt_id AND v_row.yz_open_id = p_yz_open_id
       AND v_row.kind = p_kind AND v_row.points = p_points AND v_row.parent_id IS NOT DISTINCT FROM p_parent_id THEN
      RETURN youzan_points_operation_json(v_row, true);
    END IF;
    RAISE EXCEPTION 'operation_key_payload_conflict' USING ERRCODE = '23505';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commerce_customers WHERE id = p_customer_id AND status = 'active') THEN
    RAISE EXCEPTION 'customer_not_active' USING ERRCODE = '22023';
  END IF;
  SELECT kdt_id, role, parent_kdt_id INTO v_head FROM youzan_shops WHERE kdt_id = p_kdt_id AND status = 'active';
  IF NOT FOUND OR v_head.role IS DISTINCT FROM 'hq' THEN RAISE EXCEPTION 'head_shop_invalid' USING ERRCODE = '22023'; END IF;
  SELECT kdt_id, role, parent_kdt_id INTO v_src FROM youzan_shops WHERE kdt_id = p_source_kdt_id AND status = 'active';
  IF NOT FOUND OR (CASE WHEN v_src.role = 'hq' THEN v_src.kdt_id ELSE v_src.parent_kdt_id END) IS DISTINCT FROM p_kdt_id THEN
    RAISE EXCEPTION 'source_shop_not_under_head' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM youzan_points_operations WHERE kdt_id = p_kdt_id
             AND ((yz_open_id = p_yz_open_id AND customer_id <> p_customer_id)
               OR (customer_id = p_customer_id AND yz_open_id <> p_yz_open_id))) THEN
    RAISE EXCEPTION 'identity_customer_conflict' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'debit' AND p_parent_id IS NOT NULL THEN RAISE EXCEPTION 'debit_parent_not_allowed' USING ERRCODE = '22023'; END IF;
  IF p_kind = 'refund' AND p_parent_id IS NULL THEN RAISE EXCEPTION 'refund_parent_required' USING ERRCODE = '22023'; END IF;
  -- Blocked-before-send and officially reconciled-absent operations never reached Youzan's ledger.
  IF EXISTS (SELECT 1 FROM youzan_points_operations WHERE kdt_id = p_kdt_id AND customer_id = p_customer_id
             AND (status IN ('pending','processing','unknown')
               OR (status = 'blocked' AND resolution IS DISTINCT FROM 'not_sent' AND resolution IS DISTINCT FROM 'remote_absent_reconciled'))) THEN
    RAISE EXCEPTION 'customer_operation_in_flight' USING ERRCODE = '55P03';
  END IF;
  IF p_kind = 'refund' THEN
    SELECT * INTO v_parent FROM youzan_points_operations WHERE id = p_parent_id FOR UPDATE;
    IF NOT FOUND OR v_parent.kind <> 'debit' OR v_parent.customer_id <> p_customer_id OR v_parent.kdt_id <> p_kdt_id
       OR v_parent.yz_open_id <> p_yz_open_id OR v_parent.source_kdt_id <> p_source_kdt_id THEN
      RAISE EXCEPTION 'refund_parent_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_parent.status <> 'succeeded' THEN RAISE EXCEPTION 'refund_parent_not_succeeded' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(sum(points), 0) INTO v_refunded FROM youzan_points_operations WHERE parent_id = p_parent_id
      AND NOT (status = 'blocked' AND resolution IN ('not_sent','remote_absent_reconciled'));
    IF v_refunded + p_points > v_parent.points THEN RAISE EXCEPTION 'refund_exceeds_debit' USING ERRCODE = '22023'; END IF;
  END IF;
  INSERT INTO youzan_points_operations (operation_key, customer_id, kdt_id, source_kdt_id, yz_open_id, kind, points, parent_id)
  VALUES (p_operation_key, p_customer_id, p_kdt_id, p_source_kdt_id, p_yz_open_id, p_kind, p_points, p_parent_id)
  RETURNING * INTO v_row;
  RETURN youzan_points_operation_json(v_row, false);
END $function$;

CREATE OR REPLACE FUNCTION public.youzan_points_operation_claim(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_row youzan_points_operations;
BEGIN
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('yzpts:c:' || v_row.kdt_id || ':' || v_row.customer_id, 0));
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id FOR UPDATE;
  -- Only never-sent work is claimable: pending, or an expired lease that provably never reached the send marker.
  -- unknown / blocked / sent-and-expired go to read-only reconciliation instead of a second remote write.
  IF NOT (v_row.status = 'pending'
          OR (v_row.status = 'processing' AND v_row.lease_until <= now() AND v_row.remote_sent_at IS NULL)) THEN
    RETURN NULL;
  END IF;
  IF v_row.attempts >= 8 OR v_row.created_at < now() - interval '24 hours' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM youzan_points_operations WHERE kdt_id = v_row.kdt_id AND customer_id = v_row.customer_id
             AND id <> v_row.id AND status = 'processing' AND lease_until > now()) THEN
    RETURN NULL;
  END IF;
  UPDATE youzan_points_operations SET status = 'processing', claim_token = gen_random_uuid(),
    lease_until = now() + interval '5 minutes', attempts = attempts + 1, updated_at = now()
   WHERE id = p_id RETURNING * INTO v_row;
  RETURN youzan_points_operation_json(v_row, false)
    || jsonb_build_object('claim_token', v_row.claim_token, 'lease_until', v_row.lease_until);
END $function$;

CREATE OR REPLACE FUNCTION public.youzan_points_operation_mark_sent(p_id uuid, p_claim_token uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF p_claim_token IS NULL THEN RETURN false; END IF;
  UPDATE youzan_points_operations SET remote_sent_at = now(), updated_at = now()
   WHERE id = p_id AND status = 'processing' AND claim_token = p_claim_token AND lease_until > now()
     AND remote_sent_at IS NULL;
  RETURN FOUND;
END $function$;

CREATE OR REPLACE FUNCTION public.youzan_points_operation_finish(p_id uuid, p_claim_token uuid, p_status text, p_reason text DEFAULT NULL::text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_row youzan_points_operations; v_status text := p_status; v_reason text := p_reason;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('succeeded','unknown','blocked') THEN
    RAISE EXCEPTION 'invalid_finish_status' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND p_reason !~ '^[a-z0-9_]{1,60}$' THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_claim_token IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'processing' OR v_row.claim_token IS DISTINCT FROM p_claim_token
     OR v_row.lease_until <= now() THEN RETURN false; END IF;
  -- A request that may have reached Youzan can never be marked as not sent.
  IF v_status = 'blocked' AND v_row.remote_sent_at IS NOT NULL THEN
    v_status := 'unknown'; v_reason := 'blocked_after_send';
  END IF;
  IF v_status = 'succeeded' AND v_row.remote_sent_at IS NULL THEN
    RAISE EXCEPTION 'succeeded_without_send' USING ERRCODE = '22023';
  END IF;
  UPDATE youzan_points_operations SET status = v_status, reason = v_reason,
    resolution = CASE WHEN v_status = 'blocked' THEN 'not_sent' ELSE resolution END,
    claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE id = p_id;
  RETURN true;
END $function$;

-- Read-only reconciliation against youzan.crm.customer.points.changelog.search 4.0.2 evidence.
-- matched: complete pages, exactly one biz_value match with exact signed amount -> succeeded.
-- absent / inconclusive: stays unknown (absent evidence is recorded for a separate manual resolution).
CREATE OR REPLACE FUNCTION public.youzan_points_operation_reconcile(p_id uuid, p_outcome text, p_evidence jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_row youzan_points_operations; v_amount bigint; v_begin bigint; v_end bigint; v_sent bigint;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('matched','absent','inconclusive') OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_reconcile_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_found' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('yzpts:c:' || v_row.kdt_id || ':' || v_row.customer_id, 0));
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id FOR UPDATE;
  IF v_row.remote_sent_at IS NULL OR NOT (v_row.status = 'unknown'
       OR (v_row.status = 'processing' AND v_row.lease_until <= now())) THEN
    RAISE EXCEPTION 'reconcile_not_eligible' USING ERRCODE = '22023';
  END IF;
  IF (p_evidence->>'kdt_id') IS DISTINCT FROM v_row.kdt_id::text
     OR (p_evidence->>'biz_value') IS DISTINCT FROM ('boomer-points:' || v_row.id) THEN
    RAISE EXCEPTION 'reconcile_evidence_mismatch' USING ERRCODE = '22023';
  END IF;
  v_sent := floor(extract(epoch FROM v_row.remote_sent_at))::bigint;
  IF p_outcome IN ('matched','absent') THEN
    IF jsonb_typeof(p_evidence->'pages_complete') IS DISTINCT FROM 'boolean' OR (p_evidence->>'pages_complete')::boolean IS NOT TRUE
       OR jsonb_typeof(p_evidence->'match_count') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_evidence->'window_begin') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_evidence->'window_end') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'reconcile_evidence_incomplete' USING ERRCODE = '22023';
    END IF;
    v_begin := (p_evidence->>'window_begin')::bigint; v_end := (p_evidence->>'window_end')::bigint;
    IF v_begin > v_sent - 600 OR v_end < v_sent THEN RAISE EXCEPTION 'reconcile_window_insufficient' USING ERRCODE = '22023'; END IF;
  END IF;
  IF p_outcome = 'matched' THEN
    v_amount := CASE WHEN v_row.kind = 'debit' THEN -v_row.points ELSE v_row.points END;
    IF (p_evidence->>'match_count')::int <> 1 OR jsonb_typeof(p_evidence->'amount') IS DISTINCT FROM 'number'
       OR (p_evidence->>'amount')::bigint <> v_amount THEN
      RAISE EXCEPTION 'reconcile_match_invalid' USING ERRCODE = '22023';
    END IF;
    UPDATE youzan_points_operations SET status = 'succeeded', resolution = 'remote_matched_reconciled',
      reason = NULL, reconcile_evidence = p_evidence || jsonb_build_object('outcome','matched','at',now()),
      claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_id RETURNING * INTO v_row;
  ELSE
    IF p_outcome = 'absent' AND ((p_evidence->>'match_count')::int <> 0
        OR now() - v_row.remote_sent_at < interval '30 minutes' OR v_end < floor(extract(epoch FROM now()))::bigint - 120) THEN
      RAISE EXCEPTION 'reconcile_absent_not_final' USING ERRCODE = '22023';
    END IF;
    UPDATE youzan_points_operations SET status = 'unknown',
      reason = CASE WHEN p_outcome = 'absent' THEN 'reconciled_absent_pending_review' ELSE 'reconcile_inconclusive' END,
      reconcile_evidence = p_evidence || jsonb_build_object('outcome',p_outcome,'at',now()),
      claim_token = NULL, lease_until = NULL, updated_at = now() WHERE id = p_id RETURNING * INTO v_row;
  END IF;
  RETURN youzan_points_operation_json(v_row, false) || jsonb_build_object('resolution', v_row.resolution);
END $function$;

-- Manual service-only release after a recorded complete absent reconciliation. Never re-sends.
CREATE OR REPLACE FUNCTION public.youzan_points_operation_resolve_absent(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_row youzan_points_operations;
BEGIN
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_found' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('yzpts:c:' || v_row.kdt_id || ':' || v_row.customer_id, 0));
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id FOR UPDATE;
  IF v_row.status <> 'unknown' OR v_row.reconcile_evidence->>'outcome' IS DISTINCT FROM 'absent'
     OR (v_row.reconcile_evidence->>'at')::timestamptz < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'absent_resolution_not_eligible' USING ERRCODE = '22023';
  END IF;
  UPDATE youzan_points_operations SET status = 'blocked', resolution = 'remote_absent_reconciled',
    reason = 'manual_absent_confirmed', updated_at = now() WHERE id = p_id RETURNING * INTO v_row;
  RETURN youzan_points_operation_json(v_row, false) || jsonb_build_object('resolution', v_row.resolution);
END $function$;

-- 2) Frozen POS intents.
CREATE TABLE IF NOT EXISTS public.pos_points_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_op_id text NOT NULL UNIQUE,
  location_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  source_kdt_id bigint NOT NULL CHECK (source_kdt_id > 0),
  hq_kdt_id bigint NOT NULL CHECK (hq_kdt_id > 0),
  tender_mode text NOT NULL CHECK (tender_mode IN ('cash','async')),
  points integer NOT NULL CHECK (points > 0),
  points_fen bigint NOT NULL CHECK (points_fen > 0),
  points_per_yuan integer NOT NULL CHECK (points_per_yuan BETWEEN 1 AND 10000),
  rule_fingerprint text NOT NULL CHECK (rule_fingerprint ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  quote jsonb NOT NULL,
  status text NOT NULL DEFAULT 'debit_pending'
    CHECK (status IN ('debit_pending','confirmed','unknown','released','settled','cancel_pending','cancelled')),
  debit_operation_id uuid NOT NULL UNIQUE REFERENCES public.youzan_points_operations(id),
  payment_attempt_id uuid UNIQUE,
  order_id uuid UNIQUE,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_points_intents_open_idx ON public.pos_points_intents(status, updated_at)
  WHERE status IN ('debit_pending','confirmed','unknown','cancel_pending');

CREATE TABLE IF NOT EXISTS public.pos_points_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES public.pos_points_intents(id),
  kind text NOT NULL CHECK (kind IN ('cancel','return')),
  ref_key text NOT NULL CHECK (length(ref_key) BETWEEN 1 AND 64),
  points integer NOT NULL CHECK (points > 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt < 20),
  operation_id uuid UNIQUE REFERENCES public.youzan_points_operations(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitted','succeeded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id, kind, ref_key)
);
CREATE INDEX IF NOT EXISTS pos_points_refund_requests_open_idx ON public.pos_points_refund_requests(status)
  WHERE status <> 'succeeded';

GRANT ALL ON public.pos_points_intents TO service_role;
GRANT ALL ON public.pos_points_refund_requests TO service_role;
REVOKE ALL ON public.pos_points_intents FROM anon, authenticated;
REVOKE ALL ON public.pos_points_refund_requests FROM anon, authenticated;
ALTER TABLE public.pos_points_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_points_refund_requests ENABLE ROW LEVEL SECURITY;

-- Server-side quote shared by freeze and v4 (prices, eligibility and manual discount).
CREATE OR REPLACE FUNCTION public.pos_points_quote(p_items jsonb, p_discount jsonb, p_lock boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_subtotal numeric; v_eligible numeric; v_manual numeric; v_value numeric;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale requires items';
  END IF;
  IF p_lock THEN
    PERFORM 1 FROM public.inv_skus WHERE id IN
      (SELECT (item->>'sku_id')::uuid FROM jsonb_array_elements(p_items) item) ORDER BY id FOR UPDATE;
  END IF;
  SELECT sum(s.price_tier * i.quantity),
    coalesce(sum(s.price_tier * i.quantity) FILTER (WHERE s.discount_eligible AND s.sale_ownership = 'owned'),0)
    INTO v_subtotal, v_eligible FROM jsonb_to_recordset(p_items) i(sku_id uuid, quantity integer)
    JOIN public.inv_skus s ON s.id = i.sku_id;
  IF v_subtotal IS NULL THEN RAISE EXCEPTION 'sale requires items'; END IF;
  v_value := coalesce((p_discount->>'value')::numeric,0);
  CASE coalesce(p_discount->>'type','amount')
    WHEN 'amount' THEN v_manual := round(v_value,2);
    WHEN 'percentage' THEN
      IF v_value < 0 OR v_value > 100 THEN RAISE EXCEPTION 'discount value invalid'; END IF;
      v_manual := round(v_eligible * (1 - v_value / 100),2);
    WHEN 'final_price' THEN v_manual := round(v_subtotal - v_value,2);
    ELSE RAISE EXCEPTION 'discount type invalid';
  END CASE;
  IF v_manual < 0 OR v_manual > v_eligible THEN RAISE EXCEPTION 'discount exceeds eligible amount'; END IF;
  RETURN jsonb_build_object('subtotal_fen', round(v_subtotal * 100)::bigint, 'eligible_fen', round(v_eligible * 100)::bigint,
    'manual_fen', round(v_manual * 100)::bigint);
END $function$;

CREATE OR REPLACE FUNCTION public.pos_points_check_combined_authorization(p_operator_id uuid, p_location_id uuid, p_authorization_id uuid, p_saving_fen bigint, p_eligible_fen bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF (p_saving_fen > 2000 OR p_saving_fen * 10 > p_eligible_fen)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_operator_id
      AND role::text IN ('super_admin','hq_operator','store_manager')) THEN
    IF NOT EXISTS (SELECT 1 FROM public.pos_authorizations a
      WHERE a.id = p_authorization_id AND a.operator_id = p_operator_id
        AND a.location_id = p_location_id AND a.action = 'order_discount'
        AND a.status = 'approved' AND a.expires_at > now()
        AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = a.authorizer_id
          AND r.role::text IN ('super_admin','hq_operator','store_manager'))) THEN
      RAISE EXCEPTION 'discount authorization required for combined points discount';
    END IF;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.pos_points_intent_json(i public.pos_points_intents, p_replayed boolean)
 RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object('intent_id', i.id, 'client_op_id', i.client_op_id, 'status', i.status,
    'tender_mode', i.tender_mode, 'points', i.points, 'points_fen', i.points_fen,
    'payable_fen', (i.quote->>'payable_fen')::bigint, 'debit_operation_id', i.debit_operation_id,
    'payment_attempt_id', i.payment_attempt_id, 'order_id', i.order_id, 'replayed', p_replayed)
$function$;

-- Freeze: normalized request, server quote, HQ rule calibration, actor/location/source/member, then the 0032 debit row.
CREATE OR REPLACE FUNCTION public.pos_points_intent_freeze(p_shift_id uuid, p_operator_id uuid, p_client_op_id text,
  p_customer_id uuid, p_yz_open_id text, p_items jsonb, p_discount jsonb, p_tender_mode text, p_points integer,
  p_rule jsonb, p_authorization_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_shift public.pos_shifts; v_intent public.pos_points_intents; v_shop record; v_hq bigint;
  v_request jsonb; v_quote jsonb; v_ppy integer; v_fp text; v_max integer; v_fen bigint; v_payable bigint;
  v_id uuid := gen_random_uuid(); v_op jsonb;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' OR length(p_client_op_id) > 100 THEN RAISE EXCEPTION 'client operation id required'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'sale_recovery_isolation_unsupported'; END IF;
  IF p_tender_mode IS NULL OR p_tender_mode NOT IN ('cash','async') THEN RAISE EXCEPTION 'points_tender_mode_invalid'; END IF;
  IF p_points IS NULL OR p_points <= 0 THEN RAISE EXCEPTION 'points_request_invalid'; END IF;
  IF p_customer_id IS NULL OR p_yz_open_id IS NULL OR length(p_yz_open_id) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'points_customer_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || p_client_op_id, 0));
  IF EXISTS (SELECT 1 FROM public.pos_sale_cancellations WHERE client_op_id = p_client_op_id) THEN
    RAISE EXCEPTION 'sale_operation_cancelled';
  END IF;
  v_request := jsonb_build_object('shift_id', p_shift_id, 'operator_id', p_operator_id, 'customer_id', p_customer_id,
    'items', p_items, 'discount', coalesce(p_discount,'{}'::jsonb), 'tender_mode', p_tender_mode, 'points', p_points,
    'authorization_id', p_authorization_id, 'note', p_note);
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE client_op_id = p_client_op_id FOR UPDATE;
  IF FOUND THEN
    IF v_intent.request IS DISTINCT FROM v_request OR v_intent.rule_fingerprint IS DISTINCT FROM (p_rule->>'fingerprint') THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN public.pos_points_intent_json(v_intent, true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.commerce_orders WHERE source_channel = 'pos' AND idempotency_key = p_client_op_id) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR SHARE;
  IF NOT FOUND OR v_shift.status <> 'open' OR v_shift.operator_id IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'POS shift is not available';
  END IF;
  SELECT s.kdt_id, s.role, s.parent_kdt_id INTO v_shop FROM public.inv_locations l
    JOIN public.youzan_shops s ON s.id = l.shop_id WHERE l.id = v_shift.location_id AND s.status = 'active';
  IF NOT FOUND OR v_shop.kdt_id IS NULL THEN RAISE EXCEPTION 'points_store_not_mapped'; END IF;
  v_hq := CASE WHEN v_shop.role = 'hq' THEN v_shop.kdt_id ELSE v_shop.parent_kdt_id END;
  IF v_hq IS NULL OR (p_rule->>'hq_kdt_id') IS DISTINCT FROM v_hq::text THEN RAISE EXCEPTION 'points_store_not_under_hq'; END IF;
  IF jsonb_typeof(p_rule->'points_per_yuan') IS DISTINCT FROM 'number' OR jsonb_typeof(p_rule->'max_points') IS DISTINCT FROM 'number'
     OR (p_rule->>'fingerprint') IS NULL OR (p_rule->>'fingerprint') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'points_rule_not_configured';
  END IF;
  v_ppy := (p_rule->>'points_per_yuan')::integer; v_max := (p_rule->>'max_points')::integer; v_fp := p_rule->>'fingerprint';
  IF v_ppy < 1 OR v_ppy > 10000 OR v_max < 1 THEN RAISE EXCEPTION 'points_rule_not_configured'; END IF;
  IF p_points > v_max OR (p_points::bigint * 100) % v_ppy <> 0 THEN RAISE EXCEPTION 'points_balance_or_unit_invalid'; END IF;
  v_fen := p_points::bigint * 100 / v_ppy;
  v_quote := public.pos_points_quote(p_items, p_discount, false);
  v_payable := (v_quote->>'subtotal_fen')::bigint - (v_quote->>'manual_fen')::bigint - v_fen;
  IF v_fen > (v_quote->>'eligible_fen')::bigint - (v_quote->>'manual_fen')::bigint OR v_payable < 1 THEN
    RAISE EXCEPTION 'points_cap_exceeded';
  END IF;
  PERFORM public.pos_points_check_combined_authorization(p_operator_id, v_shift.location_id, p_authorization_id,
    (v_quote->>'manual_fen')::bigint + v_fen, (v_quote->>'eligible_fen')::bigint);
  v_quote := v_quote || jsonb_build_object('points_fen', v_fen, 'payable_fen', v_payable);
  v_op := public.youzan_points_operation_begin('pos-intent:' || v_id, p_customer_id, v_hq, v_shop.kdt_id,
    p_yz_open_id, 'debit', p_points, NULL);
  INSERT INTO public.pos_points_intents(id, client_op_id, location_id, shift_id, operator_id, customer_id, source_kdt_id,
    hq_kdt_id, tender_mode, points, points_fen, points_per_yuan, rule_fingerprint, request, quote, debit_operation_id)
  VALUES (v_id, p_client_op_id, v_shift.location_id, p_shift_id, p_operator_id, p_customer_id, v_shop.kdt_id, v_hq,
    p_tender_mode, p_points, v_fen, v_ppy, v_fp, v_request, v_quote, (v_op->>'id')::uuid)
  RETURNING * INTO v_intent;
  RETURN public.pos_points_intent_json(v_intent, false);
END $function$;

-- Submit a queued refund request into the 0032 ledger (cap + serialization enforced by begin).
CREATE OR REPLACE FUNCTION public.pos_points_refund_submit(p_request_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_req public.pos_points_refund_requests; v_parent youzan_points_operations; v_op jsonb; v_cur youzan_points_operations;
BEGIN
  SELECT * INTO v_req FROM public.pos_points_refund_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund_request_not_found'; END IF;
  IF v_req.status = 'submitted' THEN
    SELECT * INTO v_cur FROM youzan_points_operations WHERE id = v_req.operation_id;
    IF v_cur.status = 'succeeded' THEN
      UPDATE public.pos_points_refund_requests SET status = 'succeeded', updated_at = now() WHERE id = v_req.id RETURNING * INTO v_req;
    ELSIF v_cur.status = 'blocked' AND v_cur.resolution IN ('not_sent','remote_absent_reconciled') THEN
      -- Provably never applied: a fresh key is safe; an unknown result always keeps its original key.
      UPDATE public.pos_points_refund_requests SET status = 'queued', operation_id = NULL, attempt = attempt + 1,
        updated_at = now() WHERE id = v_req.id RETURNING * INTO v_req;
    END IF;
  END IF;
  IF v_req.status = 'queued' THEN
    SELECT o.* INTO v_parent FROM public.pos_points_intents i JOIN youzan_points_operations o ON o.id = i.debit_operation_id
      WHERE i.id = v_req.intent_id;
    BEGIN
      v_op := public.youzan_points_operation_begin('pos-intent:' || v_req.intent_id || ':' || v_req.kind || ':' ||
        v_req.ref_key || ':' || v_req.attempt, v_parent.customer_id, v_parent.kdt_id, v_parent.source_kdt_id,
        v_parent.yz_open_id, 'refund', v_req.points, v_parent.id);
      UPDATE public.pos_points_refund_requests SET status = 'submitted', operation_id = (v_op->>'id')::uuid, updated_at = now()
        WHERE id = v_req.id RETURNING * INTO v_req;
    EXCEPTION WHEN SQLSTATE '55P03' THEN NULL; -- another operation for this member is unresolved; retry later
    END;
  END IF;
  RETURN jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'operation_id', v_req.operation_id, 'points', v_req.points);
END $function$;

CREATE OR REPLACE FUNCTION public.pos_points_intent_sync(p_intent_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_intent public.pos_points_intents; v_op youzan_points_operations; v_req public.pos_points_refund_requests;
  v_released boolean; v_next text;
BEGIN
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_intent_not_found'; END IF;
  SELECT * INTO v_op FROM youzan_points_operations WHERE id = v_intent.debit_operation_id;
  v_released := v_op.status = 'blocked' AND v_op.resolution IN ('not_sent','remote_absent_reconciled');
  v_next := v_intent.status;
  IF v_intent.status IN ('debit_pending','unknown') THEN
    v_next := CASE WHEN v_op.status = 'succeeded' THEN 'confirmed'
      WHEN v_released THEN 'released'
      WHEN v_op.status = 'unknown' OR v_op.remote_sent_at IS NOT NULL THEN 'unknown'
      ELSE 'debit_pending' END;
  ELSIF v_intent.status = 'cancel_pending' THEN
    IF v_released THEN v_next := 'cancelled';
    ELSIF v_op.status = 'succeeded' THEN
      INSERT INTO public.pos_points_refund_requests(intent_id, kind, ref_key, points)
        VALUES (v_intent.id, 'cancel', 'full', v_intent.points) ON CONFLICT (intent_id, kind, ref_key) DO NOTHING;
      SELECT * INTO v_req FROM public.pos_points_refund_requests WHERE intent_id = v_intent.id AND kind = 'cancel';
      PERFORM public.pos_points_refund_submit(v_req.id);
      SELECT * INTO v_req FROM public.pos_points_refund_requests WHERE id = v_req.id;
      IF v_req.status = 'succeeded' THEN v_next := 'cancelled'; END IF;
    END IF;
  END IF;
  IF v_next IS DISTINCT FROM v_intent.status THEN
    UPDATE public.pos_points_intents SET status = v_next, row_version = row_version + 1, updated_at = now()
      WHERE id = v_intent.id RETURNING * INTO v_intent;
  END IF;
  FOR v_req IN SELECT * FROM public.pos_points_refund_requests WHERE intent_id = v_intent.id AND kind = 'return'
      AND status <> 'succeeded' ORDER BY created_at LOOP
    PERFORM public.pos_points_refund_submit(v_req.id);
  END LOOP;
  RETURN public.pos_points_intent_json(v_intent, false) || jsonb_build_object('debit_status', v_op.status);
END $function$;

-- Cancel before settlement. Async intents need a provider-confirmed closed/failed attempt (p_provider_final).
CREATE OR REPLACE FUNCTION public.pos_points_intent_cancel(p_intent_id uuid, p_operator_id uuid, p_provider_final boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_intent public.pos_points_intents; v_attempt record;
BEGIN
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE id = p_intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_intent_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || v_intent.client_op_id, 0));
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE id = p_intent_id FOR UPDATE;
  IF v_intent.operator_id IS DISTINCT FROM p_operator_id THEN RAISE EXCEPTION 'shift_forbidden'; END IF;
  IF v_intent.order_id IS NOT NULL OR v_intent.status = 'settled'
     OR EXISTS (SELECT 1 FROM public.commerce_orders WHERE source_channel = 'pos' AND idempotency_key = v_intent.client_op_id) THEN
    RAISE EXCEPTION 'points_intent_settled';
  END IF;
  IF v_intent.payment_attempt_id IS NOT NULL THEN
    SELECT status, order_id INTO v_attempt FROM public.pos_payment_attempts WHERE id = v_intent.payment_attempt_id FOR UPDATE;
    IF NOT p_provider_final OR v_attempt.status = 'paid' OR v_attempt.order_id IS NOT NULL
       OR v_attempt.status NOT IN ('closed','failed') THEN
      RAISE EXCEPTION 'points_intent_payment_not_final';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_sale_cancellations WHERE client_op_id = v_intent.client_op_id) THEN
    INSERT INTO public.pos_sale_cancellations(client_op_id, shift_id, operator_id, location_id)
      VALUES (v_intent.client_op_id, v_intent.shift_id, v_intent.operator_id, v_intent.location_id);
  END IF;
  IF v_intent.status NOT IN ('cancel_pending','cancelled') THEN
    UPDATE public.pos_points_intents SET status = CASE WHEN status = 'released' THEN 'cancelled' ELSE 'cancel_pending' END,
      row_version = row_version + 1, updated_at = now() WHERE id = v_intent.id;
  END IF;
  RETURN public.pos_points_intent_sync(v_intent.id);
END $function$;

CREATE OR REPLACE FUNCTION public.pos_points_intent_attach_attempt(p_intent_id uuid, p_attempt_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_intent public.pos_points_intents; v_attempt record;
BEGIN
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.tender_mode <> 'async' THEN RAISE EXCEPTION 'points_intent_not_async'; END IF;
  IF v_intent.payment_attempt_id IS NOT NULL THEN
    IF v_intent.payment_attempt_id = p_attempt_id THEN RETURN public.pos_points_intent_json(v_intent, true); END IF;
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  IF v_intent.status <> 'confirmed' THEN RAISE EXCEPTION 'points_intent_not_confirmed'; END IF;
  SELECT * INTO v_attempt FROM public.pos_payment_attempts WHERE id = p_attempt_id;
  IF NOT FOUND OR v_attempt.client_op_id IS DISTINCT FROM v_intent.client_op_id OR v_attempt.location_id IS DISTINCT FROM v_intent.location_id
     OR v_attempt.shift_id IS DISTINCT FROM v_intent.shift_id OR v_attempt.operator_id IS DISTINCT FROM v_intent.operator_id
     OR round(v_attempt.amount * 100)::bigint IS DISTINCT FROM (v_intent.quote->>'payable_fen')::bigint THEN
    RAISE EXCEPTION 'points_attempt_mismatch';
  END IF;
  UPDATE public.pos_points_intents SET payment_attempt_id = p_attempt_id, row_version = row_version + 1, updated_at = now()
    WHERE id = v_intent.id RETURNING * INTO v_intent;
  RETURN public.pos_points_intent_json(v_intent, false);
END $function$;

-- v4: settle only a confirmed HQ debit; recompute and compare the frozen quote; never touches the local wallet.
CREATE OR REPLACE FUNCTION public.pos_complete_sale_v4(p_intent_id uuid, p_operator_id uuid, p_tenders jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_intent public.pos_points_intents; v_op youzan_points_operations; v_order public.commerce_orders;
  v_shift public.pos_shifts; v_attempt record; v_quote jsonb; v_snapshot jsonb; v_result jsonb; v_line record;
  v_manual_fen bigint; v_fen bigint; v_eligible numeric; v_running numeric := 0; v_prev_discount numeric := 0;
  v_next_discount numeric; v_prev_points integer := 0; v_next_points integer; v_req jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'sale_recovery_isolation_unsupported'; END IF;
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE id = p_intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'points_intent_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-sale:' || v_intent.client_op_id, 0));
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE id = p_intent_id FOR UPDATE;
  IF v_intent.operator_id IS DISTINCT FROM p_operator_id THEN RAISE EXCEPTION 'shift_forbidden'; END IF;
  IF EXISTS (SELECT 1 FROM public.pos_sale_cancellations WHERE client_op_id = v_intent.client_op_id) THEN
    RAISE EXCEPTION 'sale_operation_cancelled';
  END IF;
  SELECT * INTO v_order FROM public.commerce_orders WHERE source_channel = 'pos' AND idempotency_key = v_intent.client_op_id;
  IF FOUND THEN
    IF v_intent.order_id IS DISTINCT FROM v_order.id THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no, 'replayed', true,
      'subtotal', v_order.subtotal, 'discount_total', v_order.discount_total, 'total_amount', v_order.total_amount,
      'points_redemption', v_order.benefit_snapshot->'points_redemption');
  END IF;
  SELECT * INTO v_op FROM youzan_points_operations WHERE id = v_intent.debit_operation_id;
  IF v_intent.status <> 'confirmed' OR v_op.status <> 'succeeded' OR v_op.points <> v_intent.points
     OR v_op.customer_id <> v_intent.customer_id OR v_op.source_kdt_id <> v_intent.source_kdt_id OR v_op.kdt_id <> v_intent.hq_kdt_id THEN
    RAISE EXCEPTION 'points_intent_not_confirmed';
  END IF;
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = v_intent.shift_id FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'open' OR v_shift.operator_id IS DISTINCT FROM p_operator_id
     OR v_shift.location_id IS DISTINCT FROM v_intent.location_id THEN
    RAISE EXCEPTION 'POS shift is not available';
  END IF;
  IF jsonb_typeof(p_tenders) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tenders) = 0 THEN RAISE EXCEPTION 'tender required'; END IF;
  IF v_intent.tender_mode = 'cash' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_tenders) t WHERE t->>'provider' IS DISTINCT FROM 'cash') THEN
      RAISE EXCEPTION 'points_tender_mode_mismatch';
    END IF;
  ELSE
    SELECT * INTO v_attempt FROM public.pos_payment_attempts WHERE id = v_intent.payment_attempt_id;
    IF NOT FOUND OR jsonb_array_length(p_tenders) <> 1 OR (p_tenders->0->>'provider') IS DISTINCT FROM v_attempt.provider
       OR v_attempt.client_op_id IS DISTINCT FROM v_intent.client_op_id OR v_attempt.order_id IS NOT NULL
       OR round((p_tenders->0->>'amount')::numeric * 100)::bigint IS DISTINCT FROM (v_intent.quote->>'payable_fen')::bigint
       OR round(v_attempt.amount * 100)::bigint IS DISTINCT FROM (v_intent.quote->>'payable_fen')::bigint THEN
      RAISE EXCEPTION 'points_tender_mode_mismatch';
    END IF;
  END IF;
  v_req := v_intent.request;
  v_quote := public.pos_points_quote(v_req->'items', v_req->'discount', true);
  IF (v_quote->>'subtotal_fen') IS DISTINCT FROM (v_intent.quote->>'subtotal_fen')
     OR (v_quote->>'eligible_fen') IS DISTINCT FROM (v_intent.quote->>'eligible_fen')
     OR (v_quote->>'manual_fen') IS DISTINCT FROM (v_intent.quote->>'manual_fen') THEN
    RAISE EXCEPTION 'points_quote_changed';
  END IF;
  v_manual_fen := (v_quote->>'manual_fen')::bigint; v_fen := v_intent.points_fen;
  v_eligible := (v_quote->>'eligible_fen')::numeric / 100;
  PERFORM public.pos_points_check_combined_authorization(p_operator_id, v_intent.location_id,
    (v_req->>'authorization_id')::uuid, v_manual_fen + v_fen, (v_quote->>'eligible_fen')::bigint);
  v_snapshot := jsonb_build_object('source','youzan_hq','intent_id',v_intent.id,'operation_id',v_op.id,
    'applied_points',v_intent.points,'discount_amount',v_fen::numeric / 100,'points_per_yuan',v_intent.points_per_yuan,
    'rule_fingerprint',v_intent.rule_fingerprint,'hq_kdt_id',v_intent.hq_kdt_id,'source_kdt_id',v_intent.source_kdt_id,
    'tender_mode',v_intent.tender_mode,'cap_basis','eligible_after_discount');
  v_result := public.pos_complete_sale_without_points(v_intent.shift_id, p_operator_id, v_intent.client_op_id,
    v_req->'items', p_tenders, v_intent.customer_id, v_req->>'note',
    jsonb_build_object('type','amount','value',(v_manual_fen + v_fen)::numeric / 100,'reason',v_req->'discount'->>'reason'),
    jsonb_build_object('points_redemption', v_snapshot), (v_req->>'authorization_id')::uuid);
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = (v_result->>'order_id')::uuid;
  UPDATE public.commerce_orders SET discount_snapshot = coalesce(v_req->'discount','{}'::jsonb),
    metadata = metadata || jsonb_build_object('pos_sale_request', v_req, 'pos_points_intent_id', v_intent.id)
    WHERE id = v_order.id;
  FOR v_line IN SELECT * FROM public.commerce_order_items WHERE order_id = v_order.id ORDER BY id LOOP
    IF (v_line.discount_snapshot->>'eligible')::boolean THEN
      v_running := v_running + v_line.line_total;
      v_next_discount := floor((v_manual_fen + v_fen) * v_running / v_eligible);
      v_next_points := floor(v_intent.points::numeric * v_running / v_eligible);
      UPDATE public.commerce_order_items SET
        discount_total = (v_next_discount - v_prev_discount) / 100,
        line_total = line_total - (v_next_discount - v_prev_discount) / 100,
        discount_snapshot = discount_snapshot || jsonb_build_object('points_allocated', v_next_points - v_prev_points)
        WHERE id = v_line.id;
      v_prev_discount := v_next_discount;
      v_prev_points := v_next_points;
    END IF;
  END LOOP;
  UPDATE public.pos_receipts SET payload = payload || jsonb_build_object('points_redemption', v_snapshot,
    'items', (SELECT jsonb_agg(jsonb_build_object('sku_id',sku_id,'title',title_snapshot,
      'unit_price',unit_price,'quantity',quantity,'line_total',line_total,'discount_total',discount_total,
      'category_code',category_code,'category_name',category_name_snapshot,
      'subcategory_code',subcategory_code,'subcategory_name',subcategory_name_snapshot,
      'brand_id',brand_id,'brand_name',brand_name_snapshot,
      'character_id',character_id,'character_name',character_name_snapshot) ORDER BY created_at,id)
      FROM public.commerce_order_items WHERE order_id = v_order.id)) WHERE order_id = v_order.id;
  UPDATE public.pos_points_intents SET status = 'settled', order_id = v_order.id, row_version = row_version + 1,
    updated_at = now() WHERE id = v_intent.id;
  RETURN v_result || jsonb_build_object('points_redemption', v_snapshot,
    'items', (SELECT payload->'items' FROM public.pos_receipts WHERE order_id = v_order.id));
END $function$;

-- Return v2: cash refund unchanged; HQ points refund queued against the original ERP debit only.
CREATE OR REPLACE FUNCTION public.pos_complete_return_v2(p_shift_id uuid, p_operator_id uuid, p_order_id uuid, p_client_op_id text, p_items jsonb, p_reason text, p_authorization_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_order public.commerce_orders; v_return public.pos_returns; v_intent public.pos_points_intents;
  v_result jsonb; v_line record; v_previous integer; v_points integer := 0; v_line_points integer;
  v_refund numeric := 0; v_amount numeric; v_queued bigint; v_req jsonb := NULL;
BEGIN
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'POS order is not returnable'; END IF;
  IF (v_order.benefit_snapshot->'points_redemption'->>'source') IS DISTINCT FROM 'youzan_hq' THEN
    RETURN public.pos_complete_return(p_shift_id,p_operator_id,p_order_id,p_client_op_id,p_items,p_reason,p_authorization_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-return:' || p_client_op_id,0));
  SELECT * INTO v_return FROM public.pos_returns WHERE client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_return.order_id IS DISTINCT FROM p_order_id OR v_return.operator_id IS DISTINCT FROM p_operator_id
      OR v_return.shift_id IS DISTINCT FROM p_shift_id THEN RAISE EXCEPTION 'return idempotency_conflict'; END IF;
    RETURN jsonb_build_object('return_id',v_return.id,'refund_total',v_return.refund_total,'replayed',true,
      'points_refund',(SELECT jsonb_build_object('points',points,'status',status) FROM public.pos_points_refund_requests
        WHERE kind = 'return' AND ref_key = v_return.id::text));
  END IF;
  PERFORM 1 FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  SELECT * INTO v_order FROM public.commerce_orders WHERE id = p_order_id FOR UPDATE;
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE order_id = p_order_id AND status = 'settled' FOR UPDATE;
  IF NOT FOUND OR v_intent.id::text IS DISTINCT FROM (v_order.benefit_snapshot->'points_redemption'->>'intent_id') THEN
    RAISE EXCEPTION 'points_intent_missing_for_order';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'return requires items'; END IF;
  v_result := public.pos_complete_return_without_points(p_shift_id,p_operator_id,p_order_id,p_client_op_id,p_items,p_reason,p_authorization_id);
  FOR v_line IN SELECT ri.quantity AS returned_now, oi.*
    FROM public.pos_return_items ri JOIN public.commerce_order_items oi ON oi.id = ri.order_item_id
    WHERE ri.return_id = (v_result->>'return_id')::uuid
  LOOP
    SELECT coalesce(sum(ri.quantity),0) INTO v_previous FROM public.pos_return_items ri
      JOIN public.pos_returns r ON r.id = ri.return_id WHERE ri.order_item_id = v_line.id
      AND r.id <> (v_result->>'return_id')::uuid AND (r.status <> 'rejected' OR r.completed_at IS NOT NULL);
    IF v_previous + v_line.returned_now > v_line.quantity THEN RAISE EXCEPTION 'return quantity exceeds remaining quantity'; END IF;
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
    SELECT coalesce(sum(points),0) INTO v_queued FROM public.pos_points_refund_requests WHERE intent_id = v_intent.id;
    IF v_queued + v_points > v_intent.points THEN RAISE EXCEPTION 'refund_exceeds_debit'; END IF;
    INSERT INTO public.pos_points_refund_requests(intent_id, kind, ref_key, points)
      VALUES (v_intent.id, 'return', v_result->>'return_id', v_points) RETURNING jsonb_build_object('id', id) INTO v_req;
    v_req := public.pos_points_refund_submit((v_req->>'id')::uuid);
  END IF;
  RETURN v_result || jsonb_build_object('refund_total', v_refund, 'points_restored', 0,
    'points_refund', CASE WHEN v_req IS NULL THEN NULL ELSE jsonb_build_object('points', v_points, 'status', v_req->>'status') END);
END $function$;

-- Cash recovery cancel: same base semantics; a frozen cash intent is cancelled and compensated in the same lock.
CREATE OR REPLACE FUNCTION public.pos_recover_sale_cancel_v2(p_shift_id uuid, p_operator_id uuid, p_client_op_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb; v_intent public.pos_points_intents; v_has boolean;
BEGIN
  SELECT * INTO v_intent FROM public.pos_points_intents WHERE client_op_id = p_client_op_id;
  v_has := FOUND;
  IF v_has AND v_intent.tender_mode = 'async' AND v_intent.order_id IS NULL THEN
    RAISE EXCEPTION 'points_intent_payment_not_final';
  END IF;
  v_result := public.pos_recover_sale_cancel(p_shift_id, p_operator_id, p_client_op_id);
  IF v_has AND v_result->>'status' = 'cancelled' THEN
    v_result := v_result || jsonb_build_object('points_intent', public.pos_points_intent_cancel(v_intent.id, p_operator_id, false));
  END IF;
  RETURN v_result;
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'youzan_points_operation_begin(text,uuid,bigint,bigint,text,text,integer,uuid)',
    'youzan_points_operation_claim(uuid)',
    'youzan_points_operation_mark_sent(uuid,uuid)',
    'youzan_points_operation_finish(uuid,uuid,text,text)',
    'youzan_points_operation_reconcile(uuid,text,jsonb)',
    'youzan_points_operation_resolve_absent(uuid)',
    'pos_points_quote(jsonb,jsonb,boolean)',
    'pos_points_check_combined_authorization(uuid,uuid,uuid,bigint,bigint)',
    'pos_points_intent_json(public.pos_points_intents,boolean)',
    'pos_points_intent_freeze(uuid,uuid,text,uuid,text,jsonb,jsonb,text,integer,jsonb,uuid,text)',
    'pos_points_refund_submit(uuid)',
    'pos_points_intent_sync(uuid)',
    'pos_points_intent_cancel(uuid,uuid,boolean)',
    'pos_points_intent_attach_attempt(uuid,uuid)',
    'pos_complete_sale_v4(uuid,uuid,jsonb)',
    'pos_complete_return_v2(uuid,uuid,uuid,text,jsonb,text,uuid)',
    'pos_recover_sale_cancel_v2(uuid,uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
