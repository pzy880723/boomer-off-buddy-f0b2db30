CREATE TABLE IF NOT EXISTS public.handheld_item_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  client_op_id text NOT NULL,
  op_type text NOT NULL CHECK (op_type IN ('update','delete')),
  user_id uuid NOT NULL,
  location_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, client_op_id)
);
GRANT ALL ON public.handheld_item_ops TO service_role;
REVOKE ALL ON public.handheld_item_ops FROM PUBLIC, anon, authenticated;
ALTER TABLE public.handheld_item_ops ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.handheld_item_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id uuid NOT NULL REFERENCES public.handheld_item_ops(id) ON DELETE RESTRICT,
  sku_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('update','delete')),
  actor_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  location_id uuid NOT NULL,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb,
  changed_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS handheld_item_audit_sku_idx ON public.handheld_item_audit (sku_id, created_at DESC);
GRANT ALL ON public.handheld_item_audit TO service_role;
REVOKE ALL ON public.handheld_item_audit FROM PUBLIC, anon, authenticated;
ALTER TABLE public.handheld_item_audit ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.handheld_youzan_item_sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL,
  source_op_id uuid REFERENCES public.handheld_item_ops(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','dead','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS handheld_youzan_item_sync_pending_uq
  ON public.handheld_youzan_item_sync_outbox (sku_id, shop_id) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS handheld_youzan_item_sync_due_idx
  ON public.handheld_youzan_item_sync_outbox (status, next_attempt_at);
GRANT ALL ON public.handheld_youzan_item_sync_outbox TO service_role;
REVOKE ALL ON public.handheld_youzan_item_sync_outbox FROM PUBLIC, anon, authenticated;
ALTER TABLE public.handheld_youzan_item_sync_outbox ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.handheld_item_fail(p_code text, p_detail text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_code USING ERRCODE = 'P0001', DETAIL = coalesce(p_detail, '');
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_item_replay(
  p_device_id uuid, p_client_op_id text, p_op_type text, p_user_id uuid,
  p_location_id uuid, p_sku_id uuid, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.handheld_item_ops;
BEGIN
  IF p_client_op_id IS NULL OR length(p_client_op_id) NOT BETWEEN 8 AND 128 THEN
    PERFORM public.handheld_item_fail('invalid_client_op_id', 'client_op_id 必填（8-128 字符）');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_device_id::text || '|' || p_client_op_id, 0));
  SELECT * INTO v FROM public.handheld_item_ops WHERE device_id = p_device_id AND client_op_id = p_client_op_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v.op_type <> p_op_type OR v.user_id <> p_user_id OR v.location_id <> p_location_id
     OR v.sku_id <> p_sku_id OR v.fingerprint <> p_fingerprint THEN
    PERFORM public.handheld_item_fail('client_op_id_conflict', '同一 client_op_id 已用于不同的请求');
  END IF;
  RETURN v.response || jsonb_build_object('replayed', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_item_actor(p_user_id uuid, p_location_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hq boolean; v_mgr boolean; v_perm boolean;
BEGIN
  IF p_user_id IS NULL THEN PERFORM public.handheld_item_fail('session_required', '需要员工登录'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inv_locations WHERE id = p_location_id AND is_active) THEN
    PERFORM public.handheld_item_fail('location_forbidden', '库位不存在或已停用');
  END IF;
  v_hq := public.has_role(p_user_id, 'super_admin') OR public.has_role(p_user_id, 'hq_operator');
  v_mgr := public.has_role(p_user_id, 'store_manager');
  v_perm := EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_user_id AND location_id = p_location_id);
  IF NOT v_hq AND NOT v_perm THEN
    PERFORM public.handheld_item_fail('location_forbidden', '无权操作该库位');
  END IF;
  RETURN jsonb_build_object('hq', v_hq, 'manager', v_mgr AND v_perm);
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_item_update(
  p_device_id uuid, p_user_id uuid, p_client_op_id text, p_location_id uuid,
  p_sku_id uuid, p_expected_updated_at timestamptz, p_patch jsonb, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_replay jsonb; v_actor jsonb; v_sku public.inv_skus; v_after public.inv_skus;
  v_key text; v_fields text[] := '{}';
  v_name text; v_price numeric; v_notes text; v_grade text;
  v_op_id uuid := gen_random_uuid(); v_resp jsonb; v_queued integer := 0;
BEGIN
  v_replay := public.handheld_item_replay(p_device_id, p_client_op_id, 'update', p_user_id,
                                          p_location_id, p_sku_id, p_fingerprint);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_actor := public.handheld_item_actor(p_user_id, p_location_id);
  IF NOT (v_actor->>'hq')::boolean AND NOT (v_actor->>'manager')::boolean THEN
    PERFORM public.handheld_item_fail('edit_forbidden', '仅总部或本店店长可以修改商品');
  END IF;

  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.handheld_item_fail('not_found', '商品不存在'); END IF;
  IF v_sku.status <> 'active' THEN PERFORM public.handheld_item_fail('sku_archived', '商品已归档，不能修改'); END IF;
  IF NOT (v_actor->>'hq')::boolean AND NOT EXISTS (
       SELECT 1 FROM public.inv_stocks WHERE sku_id = p_sku_id AND location_id = p_location_id) THEN
    PERFORM public.handheld_item_fail('location_forbidden', '该商品不属于当前库位');
  END IF;
  IF NOT coalesce(v_sku.is_custom_price, false) THEN
    PERFORM public.handheld_item_fail('standard_readonly', '标准品为只读商品，不能在手机端修改');
  END IF;
  IF p_expected_updated_at IS NULL OR
     date_trunc('milliseconds', v_sku.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    PERFORM public.handheld_item_fail('version_conflict', v_sku.updated_at::text);
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    PERFORM public.handheld_item_fail('validation_error', '至少修改一个字段');
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF v_key NOT IN ('name','price_tier','notes','grade') THEN
      PERFORM public.handheld_item_fail('validation_error', '不允许修改字段 ' || v_key);
    END IF;
  END LOOP;

  v_name := v_sku.name; v_price := v_sku.price_tier; v_notes := v_sku.notes; v_grade := v_sku.grade;
  IF p_patch ? 'name' THEN
    v_name := btrim(p_patch->>'name');
    IF v_name IS NULL OR length(v_name) NOT BETWEEN 1 AND 200 THEN
      PERFORM public.handheld_item_fail('validation_error', '名称需为 1-200 字');
    END IF;
  END IF;
  IF p_patch ? 'price_tier' THEN
    IF jsonb_typeof(p_patch->'price_tier') <> 'number' THEN
      PERFORM public.handheld_item_fail('validation_error', '价格必须为数字（元）');
    END IF;
    v_price := (p_patch->>'price_tier')::numeric;
    IF v_price <= 0 OR v_price >= 1000000 OR v_price <> round(v_price, 2) THEN
      PERFORM public.handheld_item_fail('validation_error', '价格以元为单位，需大于 0 且最多两位小数');
    END IF;
  END IF;
  IF p_patch ? 'notes' THEN
    v_notes := nullif(btrim(p_patch->>'notes'), '');
    IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN
      PERFORM public.handheld_item_fail('validation_error', '描述最多 2000 字');
    END IF;
  END IF;
  IF p_patch ? 'grade' THEN
    v_grade := p_patch->>'grade';
    IF v_grade IS NOT NULL AND v_grade NOT IN ('N','S','A','B','C','J') THEN
      PERFORM public.handheld_item_fail('validation_error', '成色仅支持 N/S/A/B/C/J');
    END IF;
  END IF;

  IF v_name IS DISTINCT FROM v_sku.name THEN v_fields := v_fields || 'name'::text; END IF;
  IF v_price IS DISTINCT FROM v_sku.price_tier THEN v_fields := v_fields || 'price_tier'::text; END IF;
  IF v_notes IS DISTINCT FROM v_sku.notes THEN v_fields := v_fields || 'notes'::text; END IF;
  IF v_grade IS DISTINCT FROM v_sku.grade THEN v_fields := v_fields || 'grade'::text; END IF;

  IF cardinality(v_fields) > 0 THEN
    UPDATE public.inv_skus
       SET name = v_name, price_tier = v_price, notes = v_notes, grade = v_grade, updated_at = now()
     WHERE id = p_sku_id RETURNING * INTO v_after;
    UPDATE public.commerce_listings
       SET title = v_name, price = v_price, description = v_notes, condition_grade = v_grade, updated_at = now()
     WHERE sku_id = p_sku_id AND status IN ('draft','published','reserved','hidden');
  ELSE
    v_after := v_sku;
  END IF;

  v_resp := jsonb_build_object('ok', true, 'sku_id', p_sku_id, 'updated_at', v_after.updated_at,
    'changed_fields', to_jsonb(v_fields), 'replayed', false);
  INSERT INTO public.handheld_item_ops (id, device_id, client_op_id, op_type, user_id, location_id, sku_id, fingerprint, response)
  VALUES (v_op_id, p_device_id, p_client_op_id, 'update', p_user_id, p_location_id, p_sku_id, p_fingerprint, v_resp);

  IF v_fields && ARRAY['name','price_tier']::text[] THEN
    INSERT INTO public.handheld_youzan_item_sync_outbox (sku_id, shop_id, source_op_id)
    SELECT l.sku_id, l.shop_id, v_op_id
      FROM public.sku_youzan_links l
     WHERE l.sku_id = p_sku_id AND l.role = 'branch_stock' AND l.status = 'linked'
       AND l.sync_stock AND l.yz_item_id > 0
       AND EXISTS (SELECT 1 FROM public.sku_channel_listings c
                    WHERE c.sku_id = l.sku_id AND c.shop_id = l.shop_id
                      AND c.channel = 'youzan_branch_offline' AND c.listing_status = 'published')
    ON CONFLICT (sku_id, shop_id) WHERE status IN ('pending','failed')
    DO UPDATE SET source_op_id = EXCLUDED.source_op_id, status = 'pending',
                  next_attempt_at = now(), updated_at = now();
    GET DIAGNOSTICS v_queued = ROW_COUNT;
  END IF;
  v_resp := v_resp || jsonb_build_object('youzan_sync_queued', v_queued);
  UPDATE public.handheld_item_ops SET response = v_resp WHERE id = v_op_id;

  INSERT INTO public.handheld_item_audit (op_id, sku_id, action, actor_user_id, device_id, location_id,
                                          before_snapshot, after_snapshot, changed_fields)
  VALUES (v_op_id, p_sku_id, 'update', p_user_id, p_device_id, p_location_id,
          to_jsonb(v_sku), to_jsonb(v_after), v_fields);
  RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_item_delete(
  p_device_id uuid, p_user_id uuid, p_client_op_id text, p_location_id uuid,
  p_sku_id uuid, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_replay jsonb; v_actor jsonb; v_sku public.inv_skus;
  v_op_id uuid := gen_random_uuid(); v_resp jsonb; v_state text; v_msg text; v_detail text;
BEGIN
  v_replay := public.handheld_item_replay(p_device_id, p_client_op_id, 'delete', p_user_id,
                                          p_location_id, p_sku_id, p_fingerprint);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_actor := public.handheld_item_actor(p_user_id, p_location_id);
  IF NOT (v_actor->>'hq')::boolean THEN
    PERFORM public.handheld_item_fail('delete_forbidden', '仅总部管理员可以删除商品');
  END IF;
  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN PERFORM public.handheld_item_fail('not_found', '商品不存在'); END IF;
  BEGIN
    PERFORM public.inventory_delete_unused_sku(p_sku_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_state = 'P0002' THEN PERFORM public.handheld_item_fail('not_found', v_msg); END IF;
    IF v_state = 'P0001' AND v_detail = 'sku_in_use' THEN PERFORM public.handheld_item_fail('delete_blocked', v_msg); END IF;
    IF v_state = '23503' THEN PERFORM public.handheld_item_fail('delete_blocked', '商品仍被其他业务记录引用，请归档而不是删除'); END IF;
    RAISE;
  END;
  v_resp := jsonb_build_object('ok', true, 'deleted_sku_id', p_sku_id, 'replayed', false);
  INSERT INTO public.handheld_item_ops (id, device_id, client_op_id, op_type, user_id, location_id, sku_id, fingerprint, response)
  VALUES (v_op_id, p_device_id, p_client_op_id, 'delete', p_user_id, p_location_id, p_sku_id, p_fingerprint, v_resp);
  INSERT INTO public.handheld_item_audit (op_id, sku_id, action, actor_user_id, device_id, location_id, before_snapshot)
  VALUES (v_op_id, p_sku_id, 'delete', p_user_id, p_device_id, p_location_id, to_jsonb(v_sku));
  RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_item_sync_outbox_claim(p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.handheld_youzan_item_sync_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.handheld_youzan_item_sync_outbox
     WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
        OR (status = 'processing' AND lease_until < now())
     ORDER BY next_attempt_at
     LIMIT greatest(1, least(coalesce(p_limit, 3), 20))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.handheld_youzan_item_sync_outbox o
     SET status = 'processing', attempts = o.attempts + 1, claim_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => greatest(60, coalesce(p_lease_seconds, 600))),
         updated_at = now()
    FROM due WHERE o.id = due.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_item_sync_outbox_finish(
  p_id uuid, p_claim_token uuid, p_ok boolean, p_error text, p_result jsonb, p_cancel boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.handheld_youzan_item_sync_outbox; v_status text;
BEGIN
  SELECT * INTO v_row FROM public.handheld_youzan_item_sync_outbox
   WHERE id = p_id AND claim_token = p_claim_token AND status = 'processing' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale_claim'; END IF;
  v_status := CASE WHEN p_cancel THEN 'cancelled' WHEN p_ok THEN 'done'
                   WHEN v_row.attempts >= 10 THEN 'dead' ELSE 'failed' END;
  IF v_status = 'failed' AND EXISTS (
       SELECT 1 FROM public.handheld_youzan_item_sync_outbox
        WHERE sku_id = v_row.sku_id AND shop_id = v_row.shop_id AND id <> p_id AND status IN ('pending','failed')) THEN
    v_status := 'cancelled';
  END IF;
  UPDATE public.handheld_youzan_item_sync_outbox
     SET status = v_status, lease_until = NULL, claim_token = NULL,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 1000) END,
         result = p_result,
         next_attempt_at = now() + make_interval(mins => least(60, (2 ^ least(v_row.attempts, 6))::int)),
         updated_at = now()
   WHERE id = p_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.handheld_item_fail(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_item_replay(uuid,text,text,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_item_actor(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_item_update(uuid,uuid,text,uuid,uuid,timestamptz,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_item_delete(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_item_sync_outbox_claim(integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_item_sync_outbox_finish(uuid,uuid,boolean,text,jsonb,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_item_fail(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_item_replay(uuid,text,text,uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_item_actor(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_item_update(uuid,uuid,text,uuid,uuid,timestamptz,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_item_delete(uuid,uuid,text,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_item_sync_outbox_claim(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_item_sync_outbox_finish(uuid,uuid,boolean,text,jsonb,boolean) TO service_role;