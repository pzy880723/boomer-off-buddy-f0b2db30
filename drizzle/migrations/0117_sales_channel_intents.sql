-- 0117 多渠道销售 v1：门店级商品渠道意图（miniapp/app/youzan）。
-- 只新增表/函数/触发器；不回填、不改现有 listing/库存/条码；无意图记录 = 保持旧行为。

CREATE TABLE public.sku_sales_channel_intents (
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('miniapp','app','youzan')),
  enabled boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  op_id uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id, channel)
);
CREATE INDEX sku_sales_channel_intents_disabled_idx
  ON public.sku_sales_channel_intents (sku_id, location_id) WHERE NOT enabled;

CREATE TABLE public.sku_sales_channel_ops (
  op_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('single','batch')),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.sku_sales_channel_previews (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  location_id uuid NOT NULL,
  add_channels text[] NOT NULL,
  remove_channels text[] NOT NULL,
  items jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_op_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.sku_sales_channel_intents TO service_role;
GRANT ALL ON public.sku_sales_channel_ops TO service_role;
GRANT ALL ON public.sku_sales_channel_previews TO service_role;
REVOKE ALL ON public.sku_sales_channel_intents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sku_sales_channel_ops FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sku_sales_channel_previews FROM PUBLIC, anon, authenticated;
ALTER TABLE public.sku_sales_channel_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_sales_channel_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_sales_channel_previews ENABLE ROW LEVEL SECURITY;

-- 消费端可见：仅显式 enabled=false 才拦截；未知来源保守 = 任一消费端显式关闭即拦截。
CREATE OR REPLACE FUNCTION public.sales_channel_allowed(p_sku uuid, p_location uuid, p_channel text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.sku_sales_channel_intents i
    WHERE i.sku_id = p_sku AND i.location_id = p_location AND NOT i.enabled
      AND i.channel = ANY (CASE WHEN p_channel IN ('miniapp','app') THEN ARRAY[p_channel]
                                ELSE ARRAY['miniapp','app'] END)
  )
$$;

-- 下单原子校验：在 4 个下单函数插入订单行的同一事务内执行（含旧调用方/直接 RPC）。
CREATE OR REPLACE FUNCTION public.commerce_order_item_sales_channel_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_src text; v_ch text;
BEGIN
  IF NEW.sku_id IS NULL OR NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT source_channel INTO v_src FROM public.commerce_orders WHERE id = NEW.order_id;
  IF coalesce(v_src, 'storefront') <> 'storefront' THEN RETURN NEW; END IF;
  v_ch := nullif(current_setting('boomer.sales_channel', true), '');
  IF NOT public.sales_channel_allowed(NEW.sku_id, NEW.location_id, coalesce(v_ch, 'unknown')) THEN
    RAISE EXCEPTION 'sales channel disabled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_order_item_sales_channel_guard
  BEFORE INSERT ON public.commerce_order_items
  FOR EACH ROW EXECUTE FUNCTION public.commerce_order_item_sales_channel_guard();

-- 下单包装：同一事务内设置服务端识别的渠道，再调用原下单函数（参数原样）。
CREATE OR REPLACE FUNCTION public.commerce_create_order_in_channel(p_channel text, p_function text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE a jsonb := p_args; r jsonb;
BEGIN
  IF p_channel NOT IN ('miniapp','app','unknown') THEN RAISE EXCEPTION 'invalid sales channel'; END IF;
  PERFORM set_config('boomer.sales_channel', p_channel, true);
  IF p_function = 'commerce_create_ordinary_order' THEN
    r := public.commerce_create_ordinary_order(
      (a->>'p_customer_id')::uuid, a->>'p_idempotency_key', nullif(a->'p_items','null'::jsonb),
      a->>'p_recipient_name', a->>'p_recipient_phone', nullif(a->'p_shipping_address','null'::jsonb),
      a->>'p_courier_provider', a->>'p_courier_service_code', a->>'p_courier_service_name',
      (a->>'p_shipping_fee')::numeric, nullif(a->'p_quote_snapshot','null'::jsonb), a->>'p_customer_note',
      a->>'p_merchant_id', a->>'p_app_id',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(a->'p_owned_location_ids','[]'::jsonb)))::uuid[]);
  ELSIF p_function = 'commerce_create_ordinary_pickup_order' THEN
    r := public.commerce_create_ordinary_pickup_order(
      (a->>'p_customer_id')::uuid, a->>'p_idempotency_key', nullif(a->'p_items','null'::jsonb),
      a->>'p_recipient_name', a->>'p_recipient_phone', nullif(a->'p_quote_snapshot','null'::jsonb),
      a->>'p_customer_note', a->>'p_merchant_id', a->>'p_app_id',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(a->'p_owned_location_ids','[]'::jsonb)))::uuid[]);
  ELSIF p_function = 'commerce_create_ordinary_flash_order' THEN
    r := public.commerce_create_ordinary_flash_order(
      (a->>'p_customer_id')::uuid, a->>'p_idempotency_key', nullif(a->'p_items','null'::jsonb),
      a->>'p_recipient_name', a->>'p_recipient_phone', nullif(a->'p_shipping_address','null'::jsonb),
      nullif(a->'p_quote_snapshot','null'::jsonb), a->>'p_customer_note', a->>'p_merchant_id', a->>'p_app_id',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(a->'p_owned_location_ids','[]'::jsonb)))::uuid[]);
  ELSIF p_function = 'commerce_create_order_v2' THEN
    r := to_jsonb(public.commerce_create_order_v2(
      (a->>'p_user_id')::uuid, a->>'p_idempotency_key', nullif(a->'p_items','null'::jsonb),
      a->>'p_recipient_name', a->>'p_recipient_phone', nullif(a->'p_shipping_address','null'::jsonb),
      a->>'p_courier_provider', a->>'p_courier_service_code', a->>'p_courier_service_name',
      (a->>'p_shipping_fee')::numeric, nullif(a->'p_quote_snapshot','null'::jsonb), a->>'p_customer_note'));
  ELSE
    RAISE EXCEPTION 'unsupported create function';
  END IF;
  PERFORM set_config('boomer.sales_channel', '', true);
  RETURN r;
END $$;

-- 核心写入：单件/批量共用。逐项校验角色、门店、商品归属、预期版本；op_id 绑定 actor+门店+请求哈希。
CREATE OR REPLACE FUNCTION public.sales_channel_apply(
  p_actor uuid, p_location uuid, p_op_id uuid, p_kind text, p_request_hash text, p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_op public.sku_sales_channel_ops; v_loc record; v_is_hq boolean; v_results jsonb := '[]'::jsonb;
  c record; v_qty integer; v_sku record; v_intent public.sku_sales_channel_intents; v_cur bigint;
  v_listing record; v_yz record; v_shop record; v_reason text; v_status text; v_new bigint; v_platform_on boolean;
BEGIN
  IF p_actor IS NULL OR p_location IS NULL OR p_op_id IS NULL OR p_kind NOT IN ('single','batch')
     OR coalesce(p_request_hash,'') = '' OR jsonb_typeof(p_changes) <> 'array' THEN
    RAISE EXCEPTION 'invalid_request';
  END IF;
  IF jsonb_array_length(p_changes) = 0 OR jsonb_array_length(p_changes) > 300
     OR (SELECT count(DISTINCT e->>'sku_id') FROM jsonb_array_elements(p_changes) e) > 100 THEN
    RAISE EXCEPTION 'batch_limit';
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
  SELECT id, access_token, expires_at INTO v_shop FROM public.youzan_shops WHERE id = v_loc.shop_id;

  FOR c IN
    SELECT (e->>'sku_id')::uuid AS sku_id, e->>'channel' AS channel, (e->>'enabled')::boolean AS enabled,
           (e->>'expected_version')::bigint AS expected_version
    FROM jsonb_array_elements(p_changes) e ORDER BY e->>'sku_id', e->>'channel'
  LOOP
    v_reason := NULL; v_status := NULL;
    IF c.sku_id IS NULL OR c.channel NOT IN ('miniapp','app','youzan') OR c.enabled IS NULL OR c.expected_version IS NULL THEN
      v_results := v_results || jsonb_build_object('sku_id', c.sku_id, 'channel', c.channel, 'success', false, 'reason', 'invalid_change');
      CONTINUE;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('sales_channel:' || c.sku_id::text || ':' || p_location::text, 0));
    SELECT id, sales_state, inventory_version INTO v_sku FROM public.inv_skus WHERE id = c.sku_id;
    SELECT qty INTO v_qty FROM public.inv_stocks WHERE sku_id = c.sku_id AND location_id = p_location;
    IF v_sku.id IS NULL OR NOT FOUND THEN
      v_reason := 'not_in_store';
    END IF;
    SELECT * INTO v_intent FROM public.sku_sales_channel_intents
      WHERE sku_id = c.sku_id AND location_id = p_location AND channel = c.channel FOR UPDATE;
    v_cur := coalesce(v_intent.version, 0);
    IF v_reason IS NULL AND c.expected_version <> v_cur THEN v_reason := 'version_conflict'; END IF;

    v_yz := NULL; v_listing := NULL;
    IF v_reason IS NULL AND c.channel IN ('miniapp','app') THEN
      SELECT id, status INTO v_listing FROM public.commerce_listings WHERE sku_id = c.sku_id AND location_id = p_location;
      IF c.enabled AND v_listing.id IS NULL THEN v_reason := 'no_store_listing';
      ELSIF c.enabled AND (v_listing.status IN ('sold','archived') OR v_sku.sales_state <> 'active') THEN v_reason := 'sold_locked';
      END IF;
    ELSIF v_reason IS NULL AND c.channel = 'youzan' THEN
      SELECT id, external_item_id, listing_status INTO v_yz FROM public.sku_channel_listings
        WHERE sku_id = c.sku_id AND channel = 'youzan_branch_offline' AND shop_id = v_loc.shop_id
        ORDER BY updated_at DESC LIMIT 1;
      IF v_loc.shop_id IS NULL OR v_shop.id IS NULL THEN v_reason := 'youzan_shop_unbound';
      ELSIF v_shop.access_token IS NULL OR (v_shop.expires_at IS NOT NULL AND v_shop.expires_at < now()) THEN v_reason := 'youzan_auth_expired';
      ELSIF v_yz.id IS NULL OR v_yz.external_item_id IS NULL THEN v_reason := 'youzan_not_mapped';
      ELSIF c.enabled AND v_sku.sales_state <> 'active' THEN v_reason := 'sold_locked';
      ELSIF c.enabled AND coalesce(v_qty, 0) <= 0 THEN v_reason := 'no_stock';
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      v_results := v_results || jsonb_build_object('sku_id', c.sku_id, 'channel', c.channel, 'success', false,
        'reason', v_reason, 'version', v_cur);
      CONTINUE;
    END IF;

    IF v_intent.sku_id IS NOT NULL AND v_intent.enabled = c.enabled THEN
      v_results := v_results || jsonb_build_object('sku_id', c.sku_id, 'channel', c.channel, 'success', true,
        'status', 'unchanged', 'version', v_cur);
      CONTINUE;
    END IF;
    v_new := v_cur + 1;
    INSERT INTO public.sku_sales_channel_intents(sku_id, location_id, channel, enabled, version, op_id, updated_by)
      VALUES (c.sku_id, p_location, c.channel, c.enabled, v_new, p_op_id, p_actor)
      ON CONFLICT (sku_id, location_id, channel) DO UPDATE
      SET enabled = EXCLUDED.enabled, version = EXCLUDED.version, op_id = EXCLUDED.op_id,
          updated_by = EXCLUDED.updated_by, updated_at = now();
    v_status := 'applied';
    IF c.channel = 'youzan' THEN
      -- 旧的未执行意图任务全部作废，只保留最新一条
      UPDATE public.channel_sync_outbox SET status = 'superseded', last_error = 'superseded: newer sales channel intent',
             updated_at = now(), completed_at = now()
       WHERE channel_listing_id = v_yz.id AND status IN ('pending','retry_wait')
         AND request_payload->>'source' = 'sales_channel_intent';
      v_platform_on := v_yz.listing_status = 'published';
      IF v_platform_on IS DISTINCT FROM c.enabled THEN
        INSERT INTO public.channel_sync_outbox(sku_id, channel_listing_id, channel, shop_id, action, priority,
          inventory_version, dedupe_key, status, request_payload)
        VALUES (c.sku_id, v_yz.id, 'youzan_branch_offline', v_loc.shop_id,
          CASE WHEN c.enabled THEN 'shelf' ELSE 'delist' END, 3, coalesce(v_sku.inventory_version, 0),
          'salesch:' || v_yz.id::text || ':' || v_new::text, 'pending',
          jsonb_build_object('source','sales_channel_intent','location_id',p_location,'intent_version',v_new,
                             'enabled',c.enabled,'op_id',p_op_id));
        v_status := 'queued';
      END IF;
    END IF;
    v_results := v_results || jsonb_build_object('sku_id', c.sku_id, 'channel', c.channel, 'success', true,
      'status', v_status, 'version', v_new);
  END LOOP;

  INSERT INTO public.sku_sales_channel_ops(op_id, actor_user_id, location_id, kind, request_hash, result)
    VALUES (p_op_id, p_actor, p_location, p_kind, p_request_hash, jsonb_build_object('results', v_results));
  RETURN jsonb_build_object('results', v_results, 'replayed', false);
END $$;

-- 批量应用：只使用快照（actor+门店+SKU+版本+变更+有效期）里的内容，单次消费。
CREATE OR REPLACE FUNCTION public.sales_channel_apply_preview(p_actor uuid, p_location uuid, p_op_id uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p public.sku_sales_channel_previews; v_changes jsonb; v_hash text := 'preview:' || p_token::text;
BEGIN
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
  RETURN public.sales_channel_apply(p_actor, p_location, p_op_id, 'batch', v_hash, v_changes);
END $$;

REVOKE ALL ON FUNCTION public.sales_channel_allowed(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_order_item_sales_channel_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_create_order_in_channel(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_channel_apply(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_channel_apply_preview(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_channel_allowed(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_order_in_channel(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_channel_apply(uuid, uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_channel_apply_preview(uuid, uuid, uuid, uuid) TO service_role;
