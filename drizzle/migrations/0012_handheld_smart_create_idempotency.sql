-- 0012 手持端智能上架幂等 + 有赞发布 outbox + 重复孤品撤销审计
-- 1) handheld_smart_create_ops：(device_id, client_op_id) 唯一，记录 user/location/载荷指纹；
--    SKU 建档、EPC 绑定、一次入库、outbox 入队与幂等行在同一事务内提交。
-- 2) handheld_youzan_release_outbox：有赞门店发布持久化任务，租约 + 退避，可重启恢复。
-- 3) inv_sku_duplicate_revocations + inv_revoke_duplicate_sku：重复孤品撤销（-1 流水、归档、下架），留前值快照。

CREATE TABLE IF NOT EXISTS public.handheld_smart_create_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  client_op_id text NOT NULL,
  user_id uuid NOT NULL,
  location_id uuid NOT NULL,
  payload_fingerprint text NOT NULL,
  sku_id uuid REFERENCES public.inv_skus(id) ON DELETE RESTRICT,
  bound_epcs integer NOT NULL DEFAULT 0,
  stock_qty integer,
  status text NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','completed')),
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (device_id, client_op_id)
);
GRANT ALL ON public.handheld_smart_create_ops TO service_role;
REVOKE ALL ON public.handheld_smart_create_ops FROM PUBLIC, anon, authenticated;
ALTER TABLE public.handheld_smart_create_ops ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.handheld_youzan_release_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL,
  location_id uuid NOT NULL,
  source_op_id uuid REFERENCES public.handheld_smart_create_ops(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed','dead','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_token uuid,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, shop_id)
);
CREATE INDEX IF NOT EXISTS handheld_youzan_release_outbox_due
  ON public.handheld_youzan_release_outbox (next_attempt_at) WHERE status IN ('pending','failed','processing');
GRANT ALL ON public.handheld_youzan_release_outbox TO service_role;
REVOKE ALL ON public.handheld_youzan_release_outbox FROM PUBLIC, anon, authenticated;
ALTER TABLE public.handheld_youzan_release_outbox ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit(
  p_device_id uuid,
  p_user_id uuid,
  p_client_op_id text,
  p_fingerprint text,
  p_location_id uuid,
  p_reuse boolean,
  p_sku jsonb,
  p_epcs text[],
  p_note text,
  p_release_shop_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op public.handheld_smart_create_ops;
  v_op_id uuid;
  v_sku public.inv_skus;
  v_epc text;
  v_bound integer := 0;
  v_qty integer;
BEGIN
  IF p_device_id IS NULL OR p_user_id IS NULL OR p_location_id IS NULL OR coalesce(p_fingerprint,'') = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF p_client_op_id IS NOT NULL THEN
    -- 并发同 op：后到者在唯一索引上等待先到事务提交/回滚
    INSERT INTO public.handheld_smart_create_ops (device_id, client_op_id, user_id, location_id, payload_fingerprint)
    VALUES (p_device_id, p_client_op_id, p_user_id, p_location_id, p_fingerprint)
    ON CONFLICT (device_id, client_op_id) DO NOTHING
    RETURNING id INTO v_op_id;

    IF v_op_id IS NULL THEN
      SELECT * INTO v_op FROM public.handheld_smart_create_ops
        WHERE device_id = p_device_id AND client_op_id = p_client_op_id FOR UPDATE;
      IF v_op.user_id <> p_user_id OR v_op.location_id <> p_location_id
         OR v_op.payload_fingerprint <> p_fingerprint THEN
        RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
      END IF;
      SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_op.sku_id;
      RETURN jsonb_build_object(
        'op_id', v_op.id, 'replayed', true, 'op_status', v_op.status,
        'sku_id', v_op.sku_id, 'sku_code', v_sku.sku_code, 'epc', v_sku.epc,
        'bound_epcs', v_op.bound_epcs, 'stock_qty', v_op.stock_qty,
        'response', v_op.response_json);
    END IF;
  END IF;

  IF p_reuse THEN
    SELECT * INTO v_sku FROM public.inv_skus
      WHERE category = p_sku->>'category'
        AND price_tier = (p_sku->>'price_tier')::numeric
        AND name = p_sku->>'name'
      ORDER BY created_at LIMIT 1 FOR UPDATE;
  END IF;

  IF v_sku.id IS NULL THEN
    INSERT INTO public.inv_skus (
      category, name, price_tier, is_custom_price, inventory_policy, kind, epc, sku_code,
      image_paths, image_url, weight_g, notes, grade, attributes, category_source,
      category_confidence, classification_status, ai_suggested_price, recognition_request_id,
      ip_id, ip_candidate_text, stock_qty, status)
    VALUES (
      p_sku->>'category', p_sku->>'name', (p_sku->>'price_tier')::numeric,
      coalesce((p_sku->>'is_custom_price')::boolean, false),
      coalesce(p_sku->>'inventory_policy', 'tracked'), 'single', p_sku->>'epc', p_sku->>'sku_code',
      coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_sku->'image_paths','[]'::jsonb))), '{}'),
      p_sku->>'image_url', (p_sku->>'weight_g')::numeric, p_sku->>'notes', p_sku->>'grade',
      coalesce(p_sku->'attributes', '{}'::jsonb), coalesce(p_sku->>'category_source','manual'),
      (p_sku->>'category_confidence')::numeric, coalesce(p_sku->>'classification_status','legacy'),
      (p_sku->>'ai_suggested_price')::numeric, (p_sku->>'recognition_request_id')::uuid,
      (p_sku->>'ip_id')::uuid, p_sku->>'ip_candidate_text', 0, 'active')
    RETURNING * INTO v_sku;
  END IF;

  FOREACH v_epc IN ARRAY coalesce(p_epcs, '{}'::text[]) LOOP
    INSERT INTO public.inv_epcs (epc, sku_id, status, current_location_id, last_seen_at)
    VALUES (v_epc, v_sku.id, 'in_stock', p_location_id, now())
    ON CONFLICT (epc) DO UPDATE SET sku_id = EXCLUDED.sku_id, status = 'in_stock',
      current_location_id = EXCLUDED.current_location_id, last_seen_at = now(), updated_at = now();
    v_bound := v_bound + 1;
  END LOOP;

  v_qty := public.inv_apply_movement(v_sku.id, p_location_id, 1 + v_bound,
    'handheld_smart_create', v_sku.id, v_sku.epc, p_note);

  IF v_op_id IS NOT NULL THEN
    UPDATE public.handheld_smart_create_ops
      SET sku_id = v_sku.id, bound_epcs = v_bound, stock_qty = v_qty
      WHERE id = v_op_id;
  END IF;

  IF p_release_shop_id IS NOT NULL THEN
    INSERT INTO public.handheld_youzan_release_outbox (sku_id, shop_id, location_id, source_op_id)
    VALUES (v_sku.id, p_release_shop_id, p_location_id, v_op_id)
    ON CONFLICT (sku_id, shop_id) DO UPDATE
      SET status = CASE WHEN handheld_youzan_release_outbox.status = 'processing'
                        THEN 'processing' ELSE 'pending' END,
          next_attempt_at = now(), location_id = EXCLUDED.location_id,
          attempts = CASE WHEN handheld_youzan_release_outbox.status = 'processing'
                          THEN handheld_youzan_release_outbox.attempts ELSE 0 END,
          last_error = NULL, updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'op_id', v_op_id, 'replayed', false, 'op_status', 'committed',
    'sku_id', v_sku.id, 'sku_code', v_sku.sku_code, 'epc', v_sku.epc,
    'bound_epcs', v_bound, 'stock_qty', v_qty, 'response', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_smart_create_complete(p_op_id uuid, p_response jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.handheld_smart_create_ops
     SET status = 'completed', response_json = p_response, completed_at = now()
   WHERE id = p_op_id AND status = 'committed';
$$;

CREATE OR REPLACE FUNCTION public.handheld_release_outbox_claim(p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.handheld_youzan_release_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.handheld_youzan_release_outbox
     WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
        OR (status = 'processing' AND lease_until < now())
     ORDER BY next_attempt_at
     LIMIT greatest(1, least(coalesce(p_limit, 3), 20))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.handheld_youzan_release_outbox o
     SET status = 'processing', attempts = o.attempts + 1, claim_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => greatest(60, coalesce(p_lease_seconds, 900))),
         updated_at = now()
    FROM due WHERE o.id = due.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.handheld_release_outbox_finish(
  p_id uuid, p_claim_token uuid, p_ok boolean, p_error text, p_result jsonb, p_cancel boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.handheld_youzan_release_outbox; v_status text;
BEGIN
  SELECT * INTO v_row FROM public.handheld_youzan_release_outbox
   WHERE id = p_id AND claim_token = p_claim_token AND status = 'processing' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale_claim'; END IF;
  v_status := CASE WHEN p_cancel THEN 'cancelled' WHEN p_ok THEN 'done'
                   WHEN v_row.attempts >= 10 THEN 'dead' ELSE 'failed' END;
  UPDATE public.handheld_youzan_release_outbox
     SET status = v_status, lease_until = NULL, claim_token = NULL,
         last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 1000) END,
         result = p_result,
         next_attempt_at = now() + make_interval(mins => least(60, (2 ^ least(v_row.attempts, 6))::int)),
         updated_at = now()
   WHERE id = p_id;
  RETURN v_status;
END;
$$;

CREATE TABLE IF NOT EXISTS public.inv_sku_duplicate_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duplicate_sku_id uuid NOT NULL UNIQUE REFERENCES public.inv_skus(id) ON DELETE RESTRICT,
  kept_sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  reason text NOT NULL,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.inv_sku_duplicate_revocations TO service_role;
REVOKE ALL ON public.inv_sku_duplicate_revocations FROM PUBLIC, anon, authenticated;
ALTER TABLE public.inv_sku_duplicate_revocations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.inv_revoke_duplicate_sku(
  p_duplicate_sku_id uuid, p_kept_sku_id uuid, p_location_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.inv_sku_duplicate_revocations;
  v_before jsonb; v_after jsonb; v_qty integer; v_other integer;
BEGIN
  IF p_duplicate_sku_id = p_kept_sku_id THEN RAISE EXCEPTION '保留商品与重复商品不能相同'; END IF;
  -- 固定锁顺序：按 id 排序锁两条 SKU，再锁库存
  PERFORM 1 FROM public.inv_skus WHERE id IN (p_duplicate_sku_id, p_kept_sku_id) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM public.inv_skus WHERE id IN (p_duplicate_sku_id, p_kept_sku_id)) <> 2 THEN
    RAISE EXCEPTION '商品不存在';
  END IF;
  PERFORM 1 FROM public.inv_stocks WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id) ORDER BY sku_id, location_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.inv_sku_duplicate_revocations WHERE duplicate_sku_id = p_duplicate_sku_id;
  IF FOUND THEN
    RETURN jsonb_build_object('replayed', true, 'revocation_id', v_existing.id, 'after', v_existing.after_snapshot);
  END IF;

  IF EXISTS (SELECT 1 FROM public.commerce_order_items WHERE sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.inventory_reservations WHERE sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.inventory_reservation_lines WHERE stock_sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.inventory_sale_events WHERE sku_id = p_duplicate_sku_id)
     OR EXISTS (SELECT 1 FROM public.stock_transfer_lines WHERE sku_id = p_duplicate_sku_id) THEN
    RAISE EXCEPTION '重复商品已有订单、预占、销售或调拨记录，不能撤销';
  END IF;
  SELECT qty INTO v_qty FROM public.inv_stocks WHERE sku_id = p_duplicate_sku_id AND location_id = p_location_id;
  SELECT count(*) INTO v_other FROM public.inv_stocks
   WHERE sku_id = p_duplicate_sku_id AND location_id <> p_location_id AND qty <> 0;
  IF v_qty IS DISTINCT FROM 1 OR v_other > 0 THEN
    RAISE EXCEPTION '重复商品库存不是仅目标库位 1 件，停止撤销';
  END IF;

  v_before := jsonb_build_object(
    'duplicate', (SELECT to_jsonb(s) FROM public.inv_skus s WHERE id = p_duplicate_sku_id),
    'kept', (SELECT to_jsonb(s) FROM public.inv_skus s WHERE id = p_kept_sku_id),
    'stocks', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM public.inv_stocks x WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)),
    'listings', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM public.commerce_listings x WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)),
    'youzan_links', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM public.sku_youzan_links x WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)));

  INSERT INTO public.inv_sku_duplicate_revocations (duplicate_sku_id, kept_sku_id, location_id, reason, before_snapshot)
  VALUES (p_duplicate_sku_id, p_kept_sku_id, p_location_id, p_reason, v_before);

  PERFORM public.inv_apply_movement(p_duplicate_sku_id, p_location_id, -1, 'duplicate_listing_revoke',
    p_duplicate_sku_id, NULL, left('重复上架撤销，保留 ' || p_kept_sku_id::text || '：' || p_reason, 500));
  UPDATE public.inv_skus SET status = 'archived', is_display = false, updated_at = now()
   WHERE id = p_duplicate_sku_id;
  UPDATE public.commerce_listings SET status = 'archived', updated_at = now()
   WHERE sku_id = p_duplicate_sku_id AND status IN ('draft','published','hidden');
  UPDATE public.handheld_youzan_release_outbox SET status = 'cancelled', updated_at = now()
   WHERE sku_id = p_duplicate_sku_id AND status IN ('pending','failed');

  v_after := jsonb_build_object(
    'duplicate', (SELECT jsonb_build_object('status', status, 'is_display', is_display, 'stock_qty', stock_qty) FROM public.inv_skus WHERE id = p_duplicate_sku_id),
    'stocks', (SELECT coalesce(jsonb_agg(jsonb_build_object('sku_id', sku_id, 'location_id', location_id, 'qty', qty)), '[]') FROM public.inv_stocks WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)),
    'listings', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'sku_id', sku_id, 'status', status)), '[]') FROM public.commerce_listings WHERE sku_id IN (p_duplicate_sku_id, p_kept_sku_id)));
  UPDATE public.inv_sku_duplicate_revocations SET after_snapshot = v_after WHERE duplicate_sku_id = p_duplicate_sku_id;
  RETURN jsonb_build_object('replayed', false, 'after', v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.handheld_smart_create_commit(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_smart_create_complete(uuid,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_release_outbox_claim(integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_release_outbox_finish(uuid,uuid,boolean,text,jsonb,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inv_revoke_duplicate_sku(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_smart_create_commit(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_smart_create_complete(uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_release_outbox_claim(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_release_outbox_finish(uuid,uuid,boolean,text,jsonb,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_revoke_duplicate_sku(uuid,uuid,uuid,text) TO service_role;
