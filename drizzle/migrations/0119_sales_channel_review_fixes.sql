-- 0119 多渠道销售复审修复（0117/0118 之上增量，不改已应用历史）：
--  * 有赞共享商品（同店同 external_item_id 关联多个 ERP SKU）禁止单 SKU 设置有赞渠道。
--  * sales_channel_apply 每件商品原子：同件全部变更先校验并加锁，任一失败该件一律不改；不同商品仍可部分成功。
--  * sales_channel_apply_preview 统一 op 锁 → preview 锁，拿锁后重查 op 再重放，并发同 op 返回同一完整结果。
--  * channel_sync_outbox 旧 authenticated 读取策略：渠道意图任务仅总部或该门店授权员工可读；其他任务权限不变。

CREATE OR REPLACE FUNCTION public.sales_channel_youzan_item_shared(p_shop uuid, p_item text, p_sku uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_shop IS NOT NULL AND coalesce(p_item, '') <> '' AND (
    EXISTS (SELECT 1 FROM public.sku_channel_listings l
             WHERE l.channel = 'youzan_branch_offline' AND l.shop_id = p_shop
               AND l.external_item_id = p_item AND l.sku_id <> p_sku)
    OR EXISTS (SELECT 1 FROM public.sku_youzan_links k
                WHERE k.shop_id = p_shop AND k.yz_item_id::text = p_item AND k.sku_id <> p_sku))
$$;

CREATE OR REPLACE FUNCTION public.sales_channel_apply(
  p_actor uuid, p_location uuid, p_op_id uuid, p_kind text, p_request_hash text, p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_op public.sku_sales_channel_ops; v_loc record; v_is_hq boolean; v_results jsonb := '[]'::jsonb;
  s record; c record; p jsonb; v_plan jsonb; v_sku_res jsonb; v_failed boolean;
  v_qty integer; v_has_stock boolean; v_sku record; v_intent public.sku_sales_channel_intents; v_cur bigint;
  v_listing record; v_yz record; v_shop record; v_reason text; v_status text; v_new bigint;
BEGIN
  IF p_actor IS NULL OR p_location IS NULL OR p_op_id IS NULL OR p_kind NOT IN ('single','batch')
     OR coalesce(p_request_hash,'') = '' OR jsonb_typeof(p_changes) <> 'array' THEN
    RAISE EXCEPTION 'invalid_request';
  END IF;
  IF jsonb_array_length(p_changes) = 0 OR jsonb_array_length(p_changes) > 300
     OR (SELECT count(DISTINCT e->>'sku_id') FROM jsonb_array_elements(p_changes) e) > 100 THEN
    RAISE EXCEPTION 'batch_limit';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_changes) e)
     <> (SELECT count(DISTINCT (e->>'sku_id', e->>'channel')) FROM jsonb_array_elements(p_changes) e) THEN
    RAISE EXCEPTION 'duplicate_change';
  END IF;
  IF p_kind = 'single' AND (SELECT count(DISTINCT e->>'sku_id') FROM jsonb_array_elements(p_changes) e) <> 1 THEN
    RAISE EXCEPTION 'invalid_request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_channel_op:' || p_op_id::text, 0));
  SELECT * INTO v_op FROM public.sku_sales_channel_ops WHERE op_id = p_op_id;
  IF FOUND THEN
    IF v_op.actor_user_id = p_actor AND v_op.location_id = p_location AND v_op.kind = p_kind
       AND v_op.request_hash = p_request_hash THEN
      RETURN v_op.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'op_id_conflict';
  END IF;

  SELECT id, kind, shop_id, is_active INTO v_loc FROM public.inv_locations WHERE id = p_location;
  IF NOT FOUND OR NOT v_loc.is_active OR v_loc.kind <> 'shop' THEN RAISE EXCEPTION 'location_forbidden'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor
                 AND role::text IN ('super_admin','hq_operator','store_manager')) THEN
    RAISE EXCEPTION 'role_forbidden';
  END IF;
  v_is_hq := EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role::text IN ('super_admin','hq_operator'));
  IF NOT v_is_hq AND NOT EXISTS (SELECT 1 FROM public.user_location_perms WHERE user_id = p_actor AND location_id = p_location) THEN
    RAISE EXCEPTION 'location_forbidden';
  END IF;
  SELECT * INTO v_shop FROM public.youzan_shops WHERE id = v_loc.shop_id;

  FOR s IN
    SELECT e->>'sku_id' AS sku_text, jsonb_agg(e ORDER BY e->>'channel') AS changes
    FROM jsonb_array_elements(p_changes) e GROUP BY e->>'sku_id' ORDER BY e->>'sku_id'
  LOOP
    v_plan := '[]'::jsonb; v_failed := false;
    -- 阶段一：同件全部变更先校验并锁定，任一失败则整件不写。
    IF s.sku_text IS NOT NULL AND s.sku_text ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('sales_channel:' || s.sku_text || ':' || p_location::text, 0));
      SELECT id, sales_state, inventory_version INTO v_sku FROM public.inv_skus WHERE id = s.sku_text::uuid FOR SHARE;
      SELECT qty INTO v_qty FROM public.inv_stocks WHERE sku_id = s.sku_text::uuid AND location_id = p_location;
      v_has_stock := FOUND;
    ELSE
      SELECT NULL::uuid AS id, NULL::text AS sales_state, NULL::bigint AS inventory_version INTO v_sku; v_has_stock := false;
    END IF;
    FOR c IN
      SELECT (CASE WHEN s.sku_text ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN s.sku_text::uuid END) AS sku_id,
             e->>'channel' AS channel,
             (CASE WHEN jsonb_typeof(e->'enabled') = 'boolean' THEN (e->>'enabled')::boolean END) AS enabled,
             (CASE WHEN jsonb_typeof(e->'expected_version') = 'number' THEN (e->>'expected_version')::bigint END) AS expected_version
      FROM jsonb_array_elements(s.changes) e
    LOOP
      v_reason := NULL; v_cur := 0; v_intent := NULL;
      SELECT NULL::uuid AS id, NULL::text AS external_item_id, NULL::text AS listing_status INTO v_yz;
      SELECT NULL::uuid AS id, NULL::text AS status INTO v_listing;
      IF c.sku_id IS NULL OR c.channel IS NULL OR c.channel NOT IN ('miniapp','app','youzan')
         OR c.enabled IS NULL OR c.expected_version IS NULL THEN
        v_reason := 'invalid_change';
      ELSIF v_sku.id IS NULL OR NOT v_has_stock THEN
        v_reason := 'not_in_store';
      END IF;
      IF v_reason IS NULL THEN
        SELECT * INTO v_intent FROM public.sku_sales_channel_intents
          WHERE sku_id = c.sku_id AND location_id = p_location AND channel = c.channel FOR UPDATE;
        v_cur := coalesce(v_intent.version, 0);
        IF c.expected_version <> v_cur THEN v_reason := 'version_conflict'; END IF;
      END IF;
      IF v_reason IS NULL AND c.channel IN ('miniapp','app') THEN
        SELECT id, status INTO v_listing FROM public.commerce_listings WHERE sku_id = c.sku_id AND location_id = p_location;
        IF c.enabled AND v_listing.id IS NULL THEN v_reason := 'no_store_listing';
        ELSIF c.enabled AND (v_listing.status IN ('sold','archived') OR v_sku.sales_state <> 'active') THEN v_reason := 'sold_locked';
        END IF;
      ELSIF v_reason IS NULL AND c.channel = 'youzan' THEN
        SELECT id, external_item_id, listing_status INTO v_yz FROM public.sku_channel_listings
          WHERE sku_id = c.sku_id AND channel = 'youzan_branch_offline' AND shop_id = v_loc.shop_id
          ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;
        IF v_loc.shop_id IS NULL OR v_shop.id IS NULL OR coalesce(v_shop.status, 'active') <> 'active' THEN v_reason := 'youzan_shop_unbound';
        ELSIF v_shop.access_token IS NULL OR (v_shop.expires_at IS NOT NULL AND v_shop.expires_at < now()) THEN v_reason := 'youzan_auth_expired';
        ELSIF v_yz.id IS NULL OR v_yz.external_item_id IS NULL THEN v_reason := 'youzan_not_mapped';
        ELSIF public.sales_channel_youzan_item_shared(v_loc.shop_id, v_yz.external_item_id, c.sku_id) THEN v_reason := 'youzan_shared_item';
        ELSIF c.enabled AND v_sku.sales_state <> 'active' THEN v_reason := 'sold_locked';
        ELSIF c.enabled AND coalesce(v_qty, 0) <= 0 THEN v_reason := 'no_stock';
        END IF;
      END IF;
      IF v_reason IS NOT NULL THEN v_failed := true; END IF;
      v_plan := v_plan || jsonb_build_object('sku_id', c.sku_id, 'raw_sku', s.sku_text, 'channel', c.channel,
        'enabled', c.enabled, 'cur', v_cur, 'reason', v_reason,
        'intent_exists', v_intent.sku_id IS NOT NULL, 'intent_enabled', v_intent.enabled,
        'yz_id', v_yz.id, 'yz_status', v_yz.listing_status);
    END LOOP;

    IF v_failed THEN
      FOR p IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
        v_results := v_results || jsonb_build_object('sku_id', CASE WHEN jsonb_typeof(p->'sku_id') = 'null' THEN p->'raw_sku' ELSE p->'sku_id' END, 'channel', p->'channel',
          'success', false, 'reason', coalesce(p->>'reason', 'sku_not_modified'), 'version', (p->>'cur')::bigint,
          'sku_modified', false);
      END LOOP;
      CONTINUE;
    END IF;

    -- 阶段二：整件写入在子事务中执行；任何异常回滚本件全部意图与任务。
    v_sku_res := '[]'::jsonb;
    BEGIN
      FOR p IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
        v_cur := (p->>'cur')::bigint;
        IF (p->>'intent_exists')::boolean AND (p->>'intent_enabled')::boolean = (p->>'enabled')::boolean THEN
          v_sku_res := v_sku_res || jsonb_build_object('sku_id', p->'sku_id', 'channel', p->'channel', 'success', true,
            'status', 'unchanged', 'version', v_cur);
          CONTINUE;
        END IF;
        v_new := v_cur + 1;
        INSERT INTO public.sku_sales_channel_intents(sku_id, location_id, channel, enabled, version, op_id, updated_by)
          VALUES ((p->>'sku_id')::uuid, p_location, p->>'channel', (p->>'enabled')::boolean, v_new, p_op_id, p_actor)
          ON CONFLICT (sku_id, location_id, channel) DO UPDATE
          SET enabled = EXCLUDED.enabled, version = EXCLUDED.version, op_id = EXCLUDED.op_id,
              updated_by = EXCLUDED.updated_by, updated_at = now();
        v_status := 'applied';
        IF p->>'channel' = 'youzan' THEN
          UPDATE public.channel_sync_outbox SET status = 'superseded', last_error = 'superseded: newer sales channel intent',
                 updated_at = now(), completed_at = now()
           WHERE channel_listing_id = (p->>'yz_id')::uuid AND status IN ('pending','retry_wait')
             AND request_payload->>'source' = 'sales_channel_intent';
          IF (p->>'yz_status' = 'published') IS DISTINCT FROM (p->>'enabled')::boolean THEN
            INSERT INTO public.channel_sync_outbox(sku_id, channel_listing_id, channel, shop_id, action, priority,
              inventory_version, dedupe_key, status, request_payload)
            VALUES ((p->>'sku_id')::uuid, (p->>'yz_id')::uuid, 'youzan_branch_offline', v_loc.shop_id,
              CASE WHEN (p->>'enabled')::boolean THEN 'shelf' ELSE 'delist' END, 3, coalesce(v_sku.inventory_version, 0),
              'salesch:' || (p->>'yz_id') || ':' || v_new::text, 'pending',
              jsonb_build_object('source','sales_channel_intent','location_id',p_location,'intent_version',v_new,
                                 'enabled',(p->>'enabled')::boolean,'op_id',p_op_id));
            v_status := 'queued';
          END IF;
        END IF;
        v_sku_res := v_sku_res || jsonb_build_object('sku_id', p->'sku_id', 'channel', p->'channel', 'success', true,
          'status', v_status, 'version', v_new);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      v_sku_res := '[]'::jsonb;
      FOR p IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
        v_sku_res := v_sku_res || jsonb_build_object('sku_id', p->'sku_id', 'channel', p->'channel', 'success', false,
          'reason', 'sku_not_modified', 'version', (p->>'cur')::bigint, 'sku_modified', false);
      END LOOP;
    END;
    v_results := v_results || v_sku_res;
  END LOOP;

  INSERT INTO public.sku_sales_channel_ops(op_id, actor_user_id, location_id, kind, request_hash, result)
    VALUES (p_op_id, p_actor, p_location, p_kind, p_request_hash, jsonb_build_object('results', v_results));
  RETURN jsonb_build_object('results', v_results, 'replayed', false);
END $$;

CREATE OR REPLACE FUNCTION public.sales_channel_apply_preview(p_actor uuid, p_location uuid, p_op_id uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p public.sku_sales_channel_previews; v_changes jsonb; v_hash text := 'preview:' || p_token::text; v_res jsonb; v_extra jsonb;
BEGIN
  IF p_actor IS NULL OR p_location IS NULL OR p_op_id IS NULL OR p_token IS NULL THEN RAISE EXCEPTION 'invalid_request'; END IF;
  -- 统一锁顺序：op 锁 → preview 锁；拿到 op 锁后再判断是否重放，并发同 op 的第二个会话得到同一完整结果。
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_channel_op:' || p_op_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.sku_sales_channel_ops WHERE op_id = p_op_id) THEN
    RETURN public.sales_channel_apply(p_actor, p_location, p_op_id, 'batch', v_hash, '[{}]'::jsonb);
  END IF;
  SELECT * INTO v_p FROM public.sku_sales_channel_previews WHERE token = p_token FOR UPDATE;
  IF NOT FOUND OR v_p.actor_user_id <> p_actor OR v_p.location_id <> p_location THEN RAISE EXCEPTION 'preview_invalid'; END IF;
  IF v_p.consumed_op_id IS NOT NULL THEN RAISE EXCEPTION 'preview_consumed'; END IF;
  IF v_p.expires_at < now() THEN RAISE EXCEPTION 'preview_expired'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sku_id', it->>'sku_id', 'channel', ch.key,
           'enabled', (ch.value->>'enabled')::boolean, 'expected_version', (ch.value->>'expected_version')::bigint)), '[]'::jsonb)
    INTO v_changes
    FROM jsonb_array_elements(v_p.items) it, jsonb_each(it->'changes') ch;
  IF jsonb_array_length(v_changes) = 0 THEN RAISE EXCEPTION 'preview_empty'; END IF;
  UPDATE public.sku_sales_channel_previews SET consumed_op_id = p_op_id WHERE token = p_token;
  v_res := public.sales_channel_apply(p_actor, p_location, p_op_id, 'batch', v_hash, v_changes);
  v_extra := jsonb_build_object(
    'skipped', coalesce(v_p.skipped, '[]'::jsonb),
    'sku_ids', coalesce(to_jsonb(v_p.sku_ids),
                        (SELECT jsonb_agg(it->>'sku_id') FROM jsonb_array_elements(v_p.items) it)));
  UPDATE public.sku_sales_channel_ops SET result = result || v_extra WHERE op_id = p_op_id;
  RETURN v_res || v_extra;
END $$;

-- 旧 outbox 读取：只收紧渠道意图任务（总部或该门店授权员工）；其他任务保持原 USING (true)。
CREATE OR REPLACE FUNCTION public.channel_sync_outbox_row_visible(p_payload jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(p_payload->>'source', '') <> 'sales_channel_intent'
    OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = auth.uid() AND r.role::text IN ('super_admin','hq_operator'))
    OR EXISTS (SELECT 1 FROM public.user_location_perms u
                WHERE u.user_id = auth.uid() AND u.location_id::text = p_payload->>'location_id')
$$;
DROP POLICY IF EXISTS "auth read outbox" ON public.channel_sync_outbox;
CREATE POLICY "auth read outbox" ON public.channel_sync_outbox
  FOR SELECT TO authenticated USING (public.channel_sync_outbox_row_visible(request_payload));

REVOKE ALL ON FUNCTION public.sales_channel_youzan_item_shared(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_channel_youzan_item_shared(uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.channel_sync_outbox_row_visible(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.channel_sync_outbox_row_visible(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sales_channel_apply(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_channel_apply_preview(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_channel_apply(uuid, uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_channel_apply_preview(uuid, uuid, uuid, uuid) TO service_role;
