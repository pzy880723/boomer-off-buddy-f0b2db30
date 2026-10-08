-- 候选迁移（未应用）：翻筐乐全局分筐、冻结快照、有效翻动 1% 赠礼资格、下单原子消耗赠礼。
-- 不修改现有 commerce_create_ordinary_order / commerce_create_ordinary_pickup_order 定义：
-- 通过包装函数在同一事务内动态调用现网函数（按其当前 pg_proc 签名绑定参数），任何失败整体回滚。
-- 赠礼 SKU 通过 app_settings.key='fankuang_gift_sku_id' 配置（value: {"sku_id": "<uuid>"}），不建库存。

CREATE TABLE IF NOT EXISTS public.commerce_fankuang_rounds (
  business_date date PRIMARY KEY,
  basket_size int NOT NULL DEFAULT 100 CHECK (basket_size = 100),
  basket_count int NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commerce_fankuang_basket_slots (
  business_date date NOT NULL REFERENCES public.commerce_fankuang_rounds(business_date) ON DELETE CASCADE,
  basket_no int NOT NULL CHECK (basket_no >= 1),
  slot_no int NOT NULL CHECK (slot_no BETWEEN 1 AND 100),
  listing_id uuid NOT NULL REFERENCES public.commerce_listings(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_date, basket_no, slot_no),
  UNIQUE (business_date, listing_id)
);

CREATE TABLE IF NOT EXISTS public.commerce_fankuang_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  business_date date NOT NULL,
  basket_no int NOT NULL,
  listing_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  client_op_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (customer_id, client_op_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_fankuang_sessions_one_active
  ON public.commerce_fankuang_sessions(customer_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.commerce_fankuang_flips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  session_id uuid NOT NULL REFERENCES public.commerce_fankuang_sessions(id),
  listing_id uuid NOT NULL REFERENCES public.commerce_listings(id),
  business_date date NOT NULL,
  client_op_id text NOT NULL,
  won boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, client_op_id),
  UNIQUE (session_id, listing_id),
  UNIQUE (customer_id, business_date, listing_id)
);

CREATE TABLE IF NOT EXISTS public.commerce_fankuang_gift_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  flip_id uuid NOT NULL UNIQUE REFERENCES public.commerce_fankuang_flips(id),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'consumed')),
  order_id uuid REFERENCES public.commerce_orders(id),
  location_id uuid REFERENCES public.inv_locations(id),
  last_order_id uuid,
  release_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  reserved_at timestamptz,
  consumed_at timestamptz,
  released_at timestamptz,
  CHECK ((status = 'available') = (order_id IS NULL))
);
CREATE INDEX IF NOT EXISTS commerce_fankuang_gift_entitlements_customer
  ON public.commerce_fankuang_gift_entitlements(customer_id, status, created_at);
CREATE INDEX IF NOT EXISTS commerce_fankuang_gift_entitlements_order
  ON public.commerce_fankuang_gift_entitlements(order_id);

CREATE TABLE IF NOT EXISTS public.commerce_order_gift_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  gift_sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  quantity int NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, location_id)
);

-- 权限：仅 service_role；ERP 员工按门店只读赠礼分配。
REVOKE ALL ON public.commerce_fankuang_rounds, public.commerce_fankuang_basket_slots, public.commerce_fankuang_sessions,
  public.commerce_fankuang_flips, public.commerce_fankuang_gift_entitlements, public.commerce_order_gift_allocations
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.commerce_fankuang_rounds, public.commerce_fankuang_basket_slots, public.commerce_fankuang_sessions,
  public.commerce_fankuang_flips, public.commerce_fankuang_gift_entitlements, public.commerce_order_gift_allocations
  TO service_role;
GRANT SELECT ON public.commerce_order_gift_allocations TO authenticated;
ALTER TABLE public.commerce_fankuang_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fankuang_basket_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fankuang_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fankuang_flips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_fankuang_gift_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_gift_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff read gift allocations of their stores" ON public.commerce_order_gift_allocations
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator')
    OR EXISTS (SELECT 1 FROM public.user_location_perms p WHERE p.user_id = auth.uid() AND p.location_id = commerce_order_gift_allocations.location_id)
  );

-- ---------- 规则函数 ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_gift_probability() RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$ SELECT 0.01::numeric $$;

CREATE OR REPLACE FUNCTION public.commerce_fankuang_draw_wins() RETURNS boolean
LANGUAGE sql VOLATILE AS $$ SELECT random() < public.commerce_fankuang_gift_probability() $$;

CREATE OR REPLACE FUNCTION public.commerce_fankuang_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date $$;

CREATE OR REPLACE FUNCTION public.commerce_fankuang_gift_sku_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NULLIF(value->>'sku_id', '')::uuid FROM public.app_settings WHERE key = 'fankuang_gift_sku_id'
$$;

-- 与 src/lib/commerce/fankuang.ts isInFankuang 一致，并要求已发布、SKU active、门店真实库存 > 0。
CREATE OR REPLACE FUNCTION public.commerce_fankuang_listing_available(p_listing_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.commerce_listings l
    JOIN public.inv_skus s ON s.id = l.sku_id
    JOIN public.inv_stocks st ON st.sku_id = l.sku_id AND st.location_id = l.location_id
    WHERE l.id = p_listing_id AND l.status = 'published' AND s.status = 'active'
      AND COALESCE(s.is_display, true)
      AND s.is_custom_price IS TRUE
      AND COALESCE(s.inventory_policy, 'tracked') <> 'unlimited'
      AND COALESCE(s.kind, 'single') = 'single'
      AND st.qty > 0
      AND CASE WHEN s.fankuang_override IS TRUE THEN true
               WHEN s.fankuang_override IS FALSE THEN false
               ELSE s.price_tier > 0 AND round(s.price_tier * 100) <= 4990 END
  )
$$;

-- ---------- 每日分筐（上海 00:00 由腾讯 timer 调用；同日幂等） ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_rebuild_round(p_business_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := COALESCE(p_business_date, public.commerce_fankuang_today()); n int; c int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fankuang_round:' || d));
  SELECT basket_count INTO c FROM commerce_fankuang_rounds WHERE business_date = d;
  IF FOUND THEN RETURN jsonb_build_object('business_date', d, 'basket_count', c, 'created', false); END IF;
  INSERT INTO commerce_fankuang_rounds(business_date) VALUES (d);
  INSERT INTO commerce_fankuang_basket_slots(business_date, basket_no, slot_no, listing_id)
  SELECT d, ((rn - 1) / 100) + 1, ((rn - 1) % 100) + 1, id
  FROM (SELECT l.id, row_number() OVER (ORDER BY random()) rn
        FROM commerce_listings l WHERE l.status = 'published' AND commerce_fankuang_listing_available(l.id)) x;
  GET DIAGNOSTICS n = ROW_COUNT;
  c := ceil(n / 100.0)::int;
  UPDATE commerce_fankuang_rounds SET basket_count = c WHERE business_date = d;
  RETURN jsonb_build_object('business_date', d, 'basket_count', c, 'listing_count', n, 'created', true);
END $$;

-- 售罄/下架缺口用最新上架补齐；多余新品追加到未满或新筐。已开始的会话快照不受影响。
CREATE OR REPLACE FUNCTION public.commerce_fankuang_refill(p_business_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := COALESCE(p_business_date, public.commerce_fankuang_today());
  r record; v_new uuid; vb int; vs int; replaced int := 0; removed int := 0; appended int := 0;
BEGIN
  PERFORM commerce_fankuang_rebuild_round(d);
  PERFORM pg_advisory_xact_lock(hashtext('fankuang_round:' || d));
  FOR r IN SELECT basket_no, slot_no, listing_id FROM commerce_fankuang_basket_slots
           WHERE business_date = d ORDER BY basket_no, slot_no LOOP
    CONTINUE WHEN commerce_fankuang_listing_available(r.listing_id);
    SELECT l.id INTO v_new FROM commerce_listings l
     WHERE l.status = 'published' AND commerce_fankuang_listing_available(l.id)
       AND NOT EXISTS (SELECT 1 FROM commerce_fankuang_basket_slots s WHERE s.business_date = d AND s.listing_id = l.id)
     ORDER BY l.published_at DESC NULLS LAST, l.id LIMIT 1;
    IF v_new IS NULL THEN
      DELETE FROM commerce_fankuang_basket_slots WHERE business_date = d AND basket_no = r.basket_no AND slot_no = r.slot_no;
      removed := removed + 1;
    ELSE
      UPDATE commerce_fankuang_basket_slots SET listing_id = v_new, assigned_at = now()
       WHERE business_date = d AND basket_no = r.basket_no AND slot_no = r.slot_no;
      replaced := replaced + 1;
    END IF;
  END LOOP;
  FOR v_new IN SELECT l.id FROM commerce_listings l
     WHERE l.status = 'published' AND commerce_fankuang_listing_available(l.id)
       AND NOT EXISTS (SELECT 1 FROM commerce_fankuang_basket_slots s WHERE s.business_date = d AND s.listing_id = l.id)
     ORDER BY l.published_at DESC NULLS LAST, l.id LOOP
    SELECT b, s INTO vb, vs
      FROM generate_series(1, (SELECT COALESCE(max(basket_no), 0) + 1 FROM commerce_fankuang_basket_slots WHERE business_date = d)) b
      CROSS JOIN generate_series(1, 100) s
     WHERE NOT EXISTS (SELECT 1 FROM commerce_fankuang_basket_slots x WHERE x.business_date = d AND x.basket_no = b AND x.slot_no = s)
     ORDER BY b, s LIMIT 1;
    INSERT INTO commerce_fankuang_basket_slots(business_date, basket_no, slot_no, listing_id) VALUES (d, vb, vs, v_new);
    appended := appended + 1;
  END LOOP;
  UPDATE commerce_fankuang_rounds SET basket_count =
    (SELECT COUNT(DISTINCT basket_no) FROM commerce_fankuang_basket_slots WHERE business_date = d) WHERE business_date = d;
  RETURN jsonb_build_object('business_date', d, 'replaced', replaced, 'removed', removed, 'appended', appended);
END $$;

-- ---------- 会话 ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_session_json(p_session_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'business_date', s.business_date, 'basket_no', s.basket_no, 'status', s.status,
    'listing_ids', to_jsonb(s.listing_ids),
    'flipped_listing_ids', COALESCE((SELECT jsonb_agg(f.listing_id ORDER BY f.created_at) FROM commerce_fankuang_flips f WHERE f.session_id = s.id), '[]'::jsonb),
    'unavailable_listing_ids', COALESCE((SELECT jsonb_agg(x) FROM unnest(s.listing_ids) x WHERE NOT commerce_fankuang_listing_available(x)), '[]'::jsonb),
    'created_at', s.created_at, 'completed_at', s.completed_at)
  FROM commerce_fankuang_sessions s WHERE s.id = p_session_id
$$;

CREATE OR REPLACE FUNCTION public.commerce_fankuang_complete_if_done(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE done boolean;
BEGIN
  SELECT NOT EXISTS (
    SELECT 1 FROM commerce_fankuang_sessions s, unnest(s.listing_ids) x
     WHERE s.id = p_session_id
       AND NOT EXISTS (SELECT 1 FROM commerce_fankuang_flips f WHERE f.session_id = s.id AND f.listing_id = x)
       AND commerce_fankuang_listing_available(x)) INTO done;
  IF done THEN
    UPDATE commerce_fankuang_sessions SET status = 'completed', completed_at = now() WHERE id = p_session_id AND status = 'active';
  END IF;
  RETURN done;
END $$;

CREATE OR REPLACE FUNCTION public.commerce_fankuang_current_session(p_customer_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sid uuid;
BEGIN
  SELECT id INTO sid FROM commerce_fankuang_sessions WHERE customer_id = p_customer_id AND status = 'active';
  IF sid IS NULL THEN RETURN NULL; END IF;
  RETURN commerce_fankuang_session_json(sid);
END $$;

-- 有进行中的快照直接返回（冻结、不追加、不随日期续期重建）；翻完后才开新筐。
CREATE OR REPLACE FUNCTION public.commerce_fankuang_start_session(p_customer_id uuid, p_client_op_id text, p_business_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := COALESCE(p_business_date, public.commerce_fankuang_today()); sid uuid; v_basket int; v_ids uuid[];
BEGIN
  IF p_customer_id IS NULL OR length(COALESCE(p_client_op_id, '')) < 8 THEN RAISE EXCEPTION 'fankuang invalid request'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fankuang_customer:' || p_customer_id));
  SELECT id INTO sid FROM commerce_fankuang_sessions WHERE customer_id = p_customer_id AND client_op_id = p_client_op_id;
  IF sid IS NOT NULL THEN RETURN commerce_fankuang_session_json(sid) || jsonb_build_object('replayed', true); END IF;
  SELECT id INTO sid FROM commerce_fankuang_sessions WHERE customer_id = p_customer_id AND status = 'active';
  IF sid IS NOT NULL AND NOT commerce_fankuang_complete_if_done(sid) THEN
    RETURN commerce_fankuang_session_json(sid) || jsonb_build_object('replayed', false, 'resumed', true);
  END IF;
  PERFORM commerce_fankuang_refill(d);
  SELECT b.basket_no INTO v_basket FROM (SELECT DISTINCT basket_no FROM commerce_fankuang_basket_slots WHERE business_date = d) b
   ORDER BY EXISTS (SELECT 1 FROM commerce_fankuang_sessions s WHERE s.customer_id = p_customer_id AND s.business_date = d AND s.basket_no = b.basket_no), random()
   LIMIT 1;
  IF v_basket IS NULL THEN RAISE EXCEPTION 'fankuang basket empty'; END IF;
  SELECT array_agg(listing_id ORDER BY slot_no) INTO v_ids FROM commerce_fankuang_basket_slots WHERE business_date = d AND basket_no = v_basket;
  INSERT INTO commerce_fankuang_sessions(customer_id, business_date, basket_no, listing_ids, client_op_id)
  VALUES (p_customer_id, d, v_basket, v_ids, p_client_op_id) RETURNING id INTO sid;
  RETURN commerce_fankuang_session_json(sid) || jsonb_build_object('replayed', false, 'resumed', false);
END $$;

-- ---------- 翻动 + 1% 资格 ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_flip(p_customer_id uuid, p_session_id uuid, p_listing_id uuid, p_client_op_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s commerce_fankuang_sessions; f commerce_fankuang_flips; v_ent uuid; v_won boolean; d date := public.commerce_fankuang_today();
BEGIN
  IF length(COALESCE(p_client_op_id, '')) < 8 THEN RAISE EXCEPTION 'fankuang invalid request'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fankuang_customer:' || p_customer_id));
  SELECT * INTO f FROM commerce_fankuang_flips WHERE customer_id = p_customer_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF f.session_id <> p_session_id OR f.listing_id <> p_listing_id THEN RAISE EXCEPTION 'fankuang client op conflict'; END IF;
    SELECT id INTO v_ent FROM commerce_fankuang_gift_entitlements WHERE flip_id = f.id;
    RETURN jsonb_build_object('flip_id', f.id, 'counted', true, 'won', f.won, 'entitlement_id', v_ent, 'replayed', true, 'duplicate', false,
      'session_completed', (SELECT status = 'completed' FROM commerce_fankuang_sessions WHERE id = f.session_id));
  END IF;
  SELECT * INTO s FROM commerce_fankuang_sessions WHERE id = p_session_id AND customer_id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fankuang session not found'; END IF;
  IF NOT (p_listing_id = ANY (s.listing_ids)) THEN RAISE EXCEPTION 'fankuang listing not in session'; END IF;
  SELECT * INTO f FROM commerce_fankuang_flips
   WHERE (session_id = p_session_id AND listing_id = p_listing_id)
      OR (customer_id = p_customer_id AND business_date = d AND listing_id = p_listing_id) LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('flip_id', f.id, 'counted', false, 'won', false, 'entitlement_id', NULL, 'replayed', false,
      'duplicate', true, 'reason', 'already_flipped', 'session_completed', s.status = 'completed');
  END IF;
  IF s.status <> 'active' THEN
    RETURN jsonb_build_object('counted', false, 'won', false, 'entitlement_id', NULL, 'replayed', false, 'duplicate', false,
      'reason', 'session_completed', 'session_completed', true);
  END IF;
  IF NOT commerce_fankuang_listing_available(p_listing_id) THEN
    RETURN jsonb_build_object('counted', false, 'won', false, 'entitlement_id', NULL, 'replayed', false, 'duplicate', false,
      'reason', 'listing_unavailable', 'session_completed', commerce_fankuang_complete_if_done(p_session_id));
  END IF;
  v_won := commerce_fankuang_draw_wins();
  INSERT INTO commerce_fankuang_flips(customer_id, session_id, listing_id, business_date, client_op_id, won)
  VALUES (p_customer_id, p_session_id, p_listing_id, d, p_client_op_id, v_won) RETURNING * INTO f;
  IF v_won THEN
    INSERT INTO commerce_fankuang_gift_entitlements(customer_id, flip_id) VALUES (p_customer_id, f.id) RETURNING id INTO v_ent;
  END IF;
  RETURN jsonb_build_object('flip_id', f.id, 'counted', true, 'won', v_won, 'entitlement_id', v_ent, 'replayed', false,
    'duplicate', false, 'session_completed', commerce_fankuang_complete_if_done(p_session_id));
END $$;

CREATE OR REPLACE FUNCTION public.commerce_fankuang_gift_balance(p_customer_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'available', count(*) FILTER (WHERE status = 'available'),
    'reserved', count(*) FILTER (WHERE status = 'reserved'),
    'consumed', count(*) FILTER (WHERE status = 'consumed'),
    'available_entitlements', COALESCE(jsonb_agg(jsonb_build_object('id', id, 'won_at', created_at) ORDER BY created_at)
      FILTER (WHERE status = 'available'), '[]'::jsonb))
  FROM commerce_fankuang_gift_entitlements WHERE customer_id = p_customer_id
$$;

-- ---------- 赠礼 SKU 不可作为付费商品 ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_guard_gift_item() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.sku_id IS NOT NULL AND NEW.sku_id = commerce_fankuang_gift_sku_id() THEN
    RAISE EXCEPTION 'fankuang gift sku not purchasable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commerce_fankuang_guard_gift_item ON public.commerce_order_items;
CREATE TRIGGER commerce_fankuang_guard_gift_item BEFORE INSERT OR UPDATE OF sku_id ON public.commerce_order_items
  FOR EACH ROW EXECUTE FUNCTION public.commerce_fankuang_guard_gift_item();

-- ---------- 动态调用现网下单函数（按当前签名绑定，白名单） ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_call_create(p_fn text, p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_oid oid; v_parts text[] := '{}'; r record; v jsonb; k text; v_names text[];
BEGIN
  IF p_fn NOT IN ('commerce_create_ordinary_order', 'commerce_create_ordinary_pickup_order') THEN
    RAISE EXCEPTION 'fankuang create function not allowed';
  END IF;
  SELECT p.oid INTO STRICT v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  SELECT array_agg(a.name) INTO v_names FROM pg_proc p, unnest(p.proargnames) a(name) WHERE p.oid = v_oid;
  FOR k IN SELECT jsonb_object_keys(p_args) LOOP
    IF NOT (k = ANY (v_names)) THEN RAISE EXCEPTION 'fankuang unknown create argument %', k; END IF;
  END LOOP;
  FOR r IN SELECT a.name, a.typ, t.typcategory FROM pg_proc p,
           unnest(p.proargnames, p.proargtypes::oid[]) a(name, typ) JOIN pg_type t ON t.oid = a.typ
           WHERE p.oid = v_oid LOOP
    CONTINUE WHEN NOT (p_args ? r.name);
    IF r.typ IN ('jsonb'::regtype, 'json'::regtype) THEN
      v_parts := v_parts || format('%I => NULLIF($1->%L, ''null''::jsonb)::%s', r.name, r.name, format_type(r.typ, NULL));
    ELSIF r.typcategory = 'A' THEN
      v_parts := v_parts || format('%I => CASE WHEN jsonb_typeof($1->%L) = ''array'' THEN ARRAY(SELECT jsonb_array_elements_text($1->%L))::%s END',
        r.name, r.name, r.name, format_type(r.typ, NULL));
    ELSE
      v_parts := v_parts || format('%I => ($1->>%L)::%s', r.name, r.name, format_type(r.typ, NULL));
    END IF;
  END LOOP;
  EXECUTE format('SELECT to_jsonb(public.%I(%s))', p_fn, array_to_string(v_parts, ', ')) INTO v USING p_args;
  RETURN v;
END $$;

-- ---------- 下单 + 赠礼原子消耗 ----------
CREATE OR REPLACE FUNCTION public.commerce_create_order_with_fankuang_gifts(
  p_create_function text, p_args jsonb, p_gift_entitlement_ids uuid[] DEFAULT NULL, p_gift_count int DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer uuid := (p_args->>'p_customer_id')::uuid;
  v_ids uuid[] := (SELECT array_agg(DISTINCT x) FROM unnest(p_gift_entitlement_ids) x);
  v_count int := COALESCE(p_gift_count, cardinality(p_gift_entitlement_ids), 0);
  v_gift uuid := commerce_fankuang_gift_sku_id();
  v_order jsonb; v_order_id uuid; v_created timestamptz; v_paid int; v_locs uuid[]; v_ent uuid[]; v_bound uuid[]; i int;
BEGIN
  IF v_customer IS NULL OR COALESCE(p_args->>'p_idempotency_key', '') = '' THEN RAISE EXCEPTION 'fankuang invalid request'; END IF;
  IF v_count < 0 OR (p_gift_entitlement_ids IS NOT NULL AND (cardinality(v_ids) <> cardinality(p_gift_entitlement_ids) OR v_count <> cardinality(v_ids))) THEN
    RAISE EXCEPTION 'fankuang gift count mismatch';
  END IF;
  IF v_gift IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_args->'p_items', '[]'::jsonb)) e
      JOIN commerce_listings l ON l.id = (e->>'listing_id')::uuid WHERE l.sku_id = v_gift) THEN
    RAISE EXCEPTION 'fankuang gift sku not purchasable';
  END IF;
  IF v_count > 0 AND v_gift IS NULL THEN RAISE EXCEPTION 'fankuang gift sku not configured'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fankuang_customer:' || v_customer));
  v_order := commerce_fankuang_call_create(p_create_function, p_args);
  v_order_id := (v_order->>'id')::uuid;
  SELECT created_at INTO v_created FROM commerce_orders WHERE id = v_order_id;

  -- 重放：已绑定的赠礼必须与本次请求一致
  SELECT array_agg(id ORDER BY id) INTO v_bound FROM commerce_fankuang_gift_entitlements WHERE order_id = v_order_id;
  IF v_bound IS NOT NULL OR v_created < now() THEN
    IF COALESCE(cardinality(v_bound), 0) <> v_count
       OR (v_ids IS NOT NULL AND v_bound IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids) x)) THEN
      RAISE EXCEPTION 'fankuang gift idempotency conflict';
    END IF;
    RETURN v_order || jsonb_build_object('gift_allocations', COALESCE((SELECT jsonb_agg(jsonb_build_object('location_id', location_id, 'quantity', quantity) ORDER BY location_id)
      FROM commerce_order_gift_allocations WHERE order_id = v_order_id), '[]'::jsonb), 'gift_replayed', true);
  END IF;
  IF v_count = 0 THEN RETURN v_order || jsonb_build_object('gift_allocations', '[]'::jsonb); END IF;

  SELECT COALESCE(sum(quantity), 0) INTO v_paid FROM commerce_order_items WHERE order_id = v_order_id AND sku_id IS DISTINCT FROM v_gift;
  IF v_count > v_paid THEN RAISE EXCEPTION 'fankuang gift exceeds paid items'; END IF;

  IF v_ids IS NOT NULL THEN
    SELECT array_agg(id) INTO v_ent FROM (SELECT id FROM commerce_fankuang_gift_entitlements
      WHERE id = ANY (v_ids) AND customer_id = v_customer AND status = 'available' ORDER BY id FOR UPDATE) t;
  ELSE
    SELECT array_agg(id) INTO v_ent FROM (SELECT id FROM commerce_fankuang_gift_entitlements
      WHERE customer_id = v_customer AND status = 'available' ORDER BY created_at, id LIMIT v_count FOR UPDATE) t;
  END IF;
  IF COALESCE(cardinality(v_ent), 0) <> v_count THEN RAISE EXCEPTION 'fankuang gift entitlement unavailable'; END IF;

  SELECT array_agg(DISTINCT location_id ORDER BY location_id) INTO v_locs
    FROM commerce_order_items WHERE order_id = v_order_id AND sku_id IS DISTINCT FROM v_gift AND location_id IS NOT NULL;
  FOR i IN 1..v_count LOOP
    UPDATE commerce_fankuang_gift_entitlements
       SET status = 'reserved', order_id = v_order_id, last_order_id = v_order_id, reserved_at = now(),
           location_id = v_locs[1 + floor(random() * cardinality(v_locs))::int]
     WHERE id = v_ent[i];
  END LOOP;
  INSERT INTO commerce_order_gift_allocations(order_id, location_id, gift_sku_id, quantity)
  SELECT v_order_id, location_id, v_gift, count(*) FROM commerce_fankuang_gift_entitlements
   WHERE order_id = v_order_id GROUP BY location_id;
  RETURN v_order || jsonb_build_object('gift_allocations', (SELECT jsonb_agg(jsonb_build_object('location_id', location_id, 'quantity', quantity) ORDER BY location_id)
    FROM commerce_order_gift_allocations WHERE order_id = v_order_id), 'gift_replayed', false);
END $$;

-- ---------- 付款消耗 / 未付款取消一次性释放 ----------
CREATE OR REPLACE FUNCTION public.commerce_fankuang_gift_order_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
    UPDATE commerce_fankuang_gift_entitlements SET status = 'consumed', consumed_at = now()
     WHERE order_id = NEW.id AND status = 'reserved';
  ELSIF NEW.order_status IN ('cancelled', 'closed') AND OLD.order_status IS DISTINCT FROM NEW.order_status
        AND NEW.payment_status IS DISTINCT FROM 'paid' AND NEW.paid_at IS NULL THEN
    UPDATE commerce_fankuang_gift_entitlements
       SET status = 'available', order_id = NULL, location_id = NULL, released_at = now(), release_count = release_count + 1
     WHERE order_id = NEW.id AND status = 'reserved';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commerce_fankuang_gift_order_state ON public.commerce_orders;
CREATE TRIGGER commerce_fankuang_gift_order_state AFTER UPDATE OF payment_status, order_status ON public.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION public.commerce_fankuang_gift_order_state();

-- 函数仅 service_role 可执行
DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'commerce_fankuang_gift_probability()', 'commerce_fankuang_draw_wins()', 'commerce_fankuang_today()',
    'commerce_fankuang_gift_sku_id()', 'commerce_fankuang_listing_available(uuid)', 'commerce_fankuang_rebuild_round(date)',
    'commerce_fankuang_refill(date)', 'commerce_fankuang_session_json(uuid)', 'commerce_fankuang_complete_if_done(uuid)',
    'commerce_fankuang_current_session(uuid)', 'commerce_fankuang_start_session(uuid,text,date)',
    'commerce_fankuang_flip(uuid,uuid,uuid,text)', 'commerce_fankuang_gift_balance(uuid)',
    'commerce_fankuang_call_create(text,jsonb)', 'commerce_create_order_with_fankuang_gifts(text,jsonb,uuid[],int)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
