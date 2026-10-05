-- 0032: 有赞积分远程操作持久化日记（总部 points.decrease/increase 4.0.0 由腾讯 HTTP 适配器执行）。
-- 只记操作意图与执行状态；不存 access token / 手机号 / 原始响应；不改钱包/积分账本/券；不开放积分消费。
CREATE TABLE public.youzan_points_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  kdt_id bigint NOT NULL CHECK (kdt_id > 0),
  source_kdt_id bigint NOT NULL CHECK (source_kdt_id > 0),
  yz_open_id text NOT NULL CHECK (length(yz_open_id) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('debit','refund')),
  points integer NOT NULL CHECK (points > 0 AND points <= 100000000),
  parent_id uuid REFERENCES public.youzan_points_operations(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','unknown','succeeded','blocked')),
  claim_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kdt_id, operation_key),
  CHECK ((kind = 'debit' AND parent_id IS NULL) OR (kind = 'refund' AND parent_id IS NOT NULL))
);
CREATE INDEX youzan_points_operations_account_idx ON public.youzan_points_operations (kdt_id, customer_id, status);
CREATE INDEX youzan_points_operations_identity_idx ON public.youzan_points_operations (kdt_id, yz_open_id);
CREATE INDEX youzan_points_operations_parent_idx ON public.youzan_points_operations (parent_id) WHERE parent_id IS NOT NULL;
COMMENT ON TABLE public.youzan_points_operations IS
  'Durable journal for Youzan HQ points.decrease/increase 4.0.0 remote operations. Service-role only. Not a local balance; never write wallets/ledger/coupons from here.';

REVOKE ALL ON public.youzan_points_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.youzan_points_operations TO service_role;
ALTER TABLE public.youzan_points_operations ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.youzan_points_operation_json(o public.youzan_points_operations, p_idempotent boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object('id', o.id, 'operation_key', o.operation_key, 'customer_id', o.customer_id,
    'kdt_id', o.kdt_id, 'source_kdt_id', o.source_kdt_id, 'yz_open_id', o.yz_open_id, 'kind', o.kind,
    'points', o.points, 'parent_id', o.parent_id, 'status', o.status, 'attempts', o.attempts,
    'reason', o.reason, 'created_at', o.created_at, 'idempotent', p_idempotent)
$$;

CREATE FUNCTION public.youzan_points_operation_begin(
  p_operation_key text, p_customer_id uuid, p_kdt_id bigint, p_source_kdt_id bigint,
  p_yz_open_id text, p_kind text, p_points integer, p_parent_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row youzan_points_operations; v_parent youzan_points_operations; v_refunded bigint;
  v_src record; v_head record;
BEGIN
  IF p_operation_key IS NULL OR p_operation_key !~ '^[A-Za-z0-9:_-]{8,128}$'
     OR p_customer_id IS NULL OR p_kdt_id IS NULL OR p_kdt_id <= 0 OR p_source_kdt_id IS NULL OR p_source_kdt_id <= 0
     OR p_yz_open_id IS NULL OR length(p_yz_open_id) NOT BETWEEN 1 AND 128
     OR p_kind IS NULL OR p_kind NOT IN ('debit','refund') OR p_points IS NULL OR p_points <= 0 OR p_points > 100000000 THEN
    RAISE EXCEPTION 'invalid_operation' USING ERRCODE = '22023';
  END IF;

  -- 同账户串行：总部 + 会员；同时锁 yz 身份，避免跨会员并发。
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

  IF EXISTS (SELECT 1 FROM youzan_points_operations WHERE kdt_id = p_kdt_id AND customer_id = p_customer_id
             AND status IN ('pending','processing','unknown','blocked')) THEN
    RAISE EXCEPTION 'customer_operation_in_flight' USING ERRCODE = '55P03';
  END IF;

  IF p_kind = 'refund' THEN
    SELECT * INTO v_parent FROM youzan_points_operations WHERE id = p_parent_id FOR UPDATE;
    IF NOT FOUND OR v_parent.kind <> 'debit' OR v_parent.customer_id <> p_customer_id OR v_parent.kdt_id <> p_kdt_id
       OR v_parent.yz_open_id <> p_yz_open_id OR v_parent.source_kdt_id <> p_source_kdt_id THEN
      RAISE EXCEPTION 'refund_parent_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_parent.status <> 'succeeded' THEN RAISE EXCEPTION 'refund_parent_not_succeeded' USING ERRCODE = '22023'; END IF;
    -- 所有状态的退款都计入额度（含 pending/processing/unknown/blocked/succeeded）。
    SELECT coalesce(sum(points), 0) INTO v_refunded FROM youzan_points_operations WHERE parent_id = p_parent_id;
    IF v_refunded + p_points > v_parent.points THEN RAISE EXCEPTION 'refund_exceeds_debit' USING ERRCODE = '22023'; END IF;
  END IF;

  INSERT INTO youzan_points_operations (operation_key, customer_id, kdt_id, source_kdt_id, yz_open_id, kind, points, parent_id)
  VALUES (p_operation_key, p_customer_id, p_kdt_id, p_source_kdt_id, p_yz_open_id, p_kind, p_points, p_parent_id)
  RETURNING * INTO v_row;
  RETURN youzan_points_operation_json(v_row, false);
END $$;

CREATE FUNCTION public.youzan_points_operation_claim(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row youzan_points_operations;
BEGIN
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('yzpts:c:' || v_row.kdt_id || ':' || v_row.customer_id, 0));
  SELECT * INTO v_row FROM youzan_points_operations WHERE id = p_id FOR UPDATE;
  IF v_row.status = 'succeeded' THEN RETURN NULL; END IF;
  IF v_row.status = 'processing' AND v_row.lease_until > now() THEN RETURN NULL; END IF;
  -- 自动重试上限：8 次且 24 小时内；超出保持人工处理，不新建 key。
  IF v_row.attempts >= 8 OR v_row.created_at < now() - interval '24 hours' THEN RETURN NULL; END IF;
  -- 同账户已有其他有效执行中的操作：不并发。
  IF EXISTS (SELECT 1 FROM youzan_points_operations WHERE kdt_id = v_row.kdt_id AND customer_id = v_row.customer_id
             AND id <> v_row.id AND status = 'processing' AND lease_until > now()) THEN
    RETURN NULL;
  END IF;
  UPDATE youzan_points_operations SET status = 'processing', claim_token = gen_random_uuid(),
    lease_until = now() + interval '5 minutes', attempts = attempts + 1, updated_at = now()
   WHERE id = p_id RETURNING * INTO v_row;
  RETURN youzan_points_operation_json(v_row, false)
    || jsonb_build_object('claim_token', v_row.claim_token, 'lease_until', v_row.lease_until);
END $$;

CREATE FUNCTION public.youzan_points_operation_finish(p_id uuid, p_claim_token uuid, p_status text, p_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('succeeded','unknown','blocked') THEN
    RAISE EXCEPTION 'invalid_finish_status' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND p_reason !~ '^[a-z0-9_]{1,60}$' THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_claim_token IS NULL THEN RETURN false; END IF;
  UPDATE youzan_points_operations SET status = p_status, reason = p_reason, claim_token = NULL, lease_until = NULL, updated_at = now()
   WHERE id = p_id AND status = 'processing' AND claim_token = p_claim_token AND lease_until > now();
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.youzan_points_operation_json(public.youzan_points_operations, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_points_operation_begin(text,uuid,bigint,bigint,text,text,integer,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_points_operation_claim(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.youzan_points_operation_finish(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_points_operation_json(public.youzan_points_operations, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_points_operation_begin(text,uuid,bigint,bigint,text,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_points_operation_claim(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.youzan_points_operation_finish(uuid,uuid,text,text) TO service_role;