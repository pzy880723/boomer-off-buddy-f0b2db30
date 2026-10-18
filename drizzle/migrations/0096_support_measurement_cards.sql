-- 0096 尺寸申请走客服会话：受控测量卡片 + 首页待处理聚合（增量，不改 0091–0095）
ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS measurement_task_id uuid REFERENCES public.product_measurement_tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS card_kind text;
ALTER TABLE public.support_messages DROP CONSTRAINT IF EXISTS support_messages_card_kind_check;
ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_card_kind_check
  CHECK (card_kind IS NULL OR (card_kind IN ('measurement_request','measurement_completed') AND sender_type = 'system' AND internal = false));
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_messages_measurement_card
  ON public.support_messages(conversation_id, measurement_task_id, card_kind) WHERE card_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_messages_measurement_task
  ON public.support_messages(measurement_task_id) WHERE measurement_task_id IS NOT NULL;
ALTER TABLE public.product_measurement_requesters
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.support_conversations(id) ON DELETE SET NULL;

-- 为 (task, customer) 找到/创建 customer + product 上下文会话并追加一张申请卡（幂等）。
-- 门店：复用已开放会话的门店；新建时用任务门店（服务端按库存派生），缺失再用商品门店。
CREATE OR REPLACE FUNCTION public.measurement_attach_support(p_task_id uuid, p_customer_id uuid, p_backfill_at timestamptz DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE t product_measurement_tasks%ROWTYPE; l record; v_name text; v_key text; v_conv uuid; v_nick text;
BEGIN
  SELECT * INTO t FROM product_measurement_tasks WHERE id = p_task_id;
  IF NOT FOUND OR t.listing_id IS NULL THEN RETURN NULL; END IF;
  SELECT id, location_id, title, price INTO l FROM commerce_listings WHERE id = t.listing_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT name INTO v_name FROM inv_skus WHERE id = t.sku_id;
  v_key := 'product:' || l.id::text;
  SELECT id INTO v_conv FROM support_conversations
   WHERE customer_id = p_customer_id AND context_key = v_key AND status IN ('open','pending')
   ORDER BY created_at LIMIT 1;
  IF v_conv IS NULL THEN
    SELECT coalesce(nullif(nickname, ''), '顾客') INTO v_nick FROM commerce_customers WHERE id = p_customer_id;
    INSERT INTO support_conversations(customer_id, location_id, context_key, context, channel, title, topic)
    VALUES (p_customer_id, coalesce(t.location_id, l.location_id), v_key,
            jsonb_build_object('type','product','id',l.id,'title',l.title,'price',l.price),
            'native', coalesce(v_nick, '顾客') || ' 的咨询', 'product')
    ON CONFLICT (customer_id, context_key) WHERE context_key IS NOT NULL AND status IN ('open','pending') DO NOTHING
    RETURNING id INTO v_conv;
    IF v_conv IS NULL THEN
      SELECT id INTO v_conv FROM support_conversations
       WHERE customer_id = p_customer_id AND context_key = v_key AND status IN ('open','pending') LIMIT 1;
    END IF;
  END IF;
  -- 系统卡片：sender_type=system，不触发 waiting_since 设置或清除
  INSERT INTO support_messages(conversation_id, sender_type, sender_name, body, internal, delivery_status,
                               client_op_id, measurement_task_id, card_kind)
  VALUES (v_conv, 'system', '系统',
          CASE WHEN p_backfill_at IS NOT NULL
               THEN '【历史申请补录·原申请于 ' || to_char(p_backfill_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || '】' ELSE '' END
          || '顾客申请测量商品尺寸：' || coalesce(v_name, l.title, '商品'),
          false, 'sent', 'measurement_request:' || p_task_id::text, p_task_id, 'measurement_request')
  ON CONFLICT DO NOTHING;
  UPDATE product_measurement_requesters SET conversation_id = v_conv
   WHERE task_id = p_task_id AND customer_id = p_customer_id AND conversation_id IS NULL;
  RETURN v_conv;
END $$;

CREATE OR REPLACE FUNCTION public.tg_measurement_requester_support() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM measurement_attach_support(NEW.task_id, NEW.customer_id, NULL);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_measurement_requester_support ON public.product_measurement_requesters;
CREATE TRIGGER trg_measurement_requester_support AFTER INSERT ON public.product_measurement_requesters
  FOR EACH ROW EXECUTE FUNCTION public.tg_measurement_requester_support();

-- 任务完成：给每张申请卡所在会话追加一张完成卡（幂等），不改 waiting_since
CREATE OR REPLACE FUNCTION public.tg_measurement_task_completed_support() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO support_messages(conversation_id, sender_type, sender_name, body, internal, delivery_status,
                               client_op_id, measurement_task_id, card_kind)
  SELECT m.conversation_id, 'system', '系统', '商品尺寸已测量，可在商品详情查看实测尺寸。', false, 'sent',
         'measurement_completed:' || NEW.id::text, NEW.id, 'measurement_completed'
    FROM support_messages m
   WHERE m.measurement_task_id = NEW.id AND m.card_kind = 'measurement_request'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_measurement_task_completed_support ON public.product_measurement_tasks;
CREATE TRIGGER trg_measurement_task_completed_support AFTER UPDATE OF status ON public.product_measurement_tasks
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.tg_measurement_task_completed_support();

-- 语音/锁屏事件 measurement_requested 保留，但归"客户"类，不再算公司内部
CREATE OR REPLACE FUNCTION public.handheld_notification_category(p_kind text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $function$
  WITH k AS (SELECT translate(lower(coalesce(p_kind,'')), '.-', '__') AS v)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['customer','conversation','support','inquiry','measurement']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'customers'
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['order','refund','fulfillment','shipment','shortage','pickup']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'orders'
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['internal','announcement','transfer','stocktake']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'internal'
    ELSE 'system' END
  FROM k
$function$;

-- 首页待处理：全量聚合 + 稳定分页（sort_ts asc, id asc）。counts 与分页无关。
CREATE OR REPLACE FUNCTION public.handheld_work_items(
  p_user_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false,
  p_limit integer DEFAULT 50, p_cursor_ts timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH locs AS (SELECT coalesce(p_location_ids, '{}'::uuid[]) AS ids),
  cards AS (
    SELECT m.conversation_id, m.measurement_task_id, t.created_at, t.listing_id, t.sku_id
      FROM support_messages m JOIN product_measurement_tasks t ON t.id = m.measurement_task_id
     WHERE m.card_kind = 'measurement_request' AND t.status IN ('pending','claimed')
  ),
  sup AS (
    SELECT sc.*,
           (SELECT count(*) FROM cards c WHERE c.conversation_id = sc.id) AS pmc,
           (SELECT min(c.created_at) FROM cards c WHERE c.conversation_id = sc.id) AS card_at,
           (SELECT c.sku_id FROM cards c WHERE c.conversation_id = sc.id ORDER BY c.created_at LIMIT 1) AS card_sku,
           (sc.status <> 'closed' AND (sc.waiting_since IS NOT NULL OR (sc.primary_agent_id IS NULL AND EXISTS (
              SELECT 1 FROM support_messages cm WHERE cm.conversation_id = sc.id AND cm.sender_type = 'customer')))) AS needs_reply
      FROM support_conversations sc, locs
     WHERE sc.location_id = ANY (locs.ids) OR (p_include_unlocated AND sc.location_id IS NULL)
  ),
  all_items AS (
    SELECT s.id, 'support'::text AS type, 'customers'::text AS cat,
           coalesce(least(s.waiting_since, s.card_at), s.waiting_since, s.card_at, s.created_at) AS sort_ts,
           coalesce(s.title, '客户咨询') AS title,
           concat_ws(' · ', CASE WHEN s.needs_reply THEN CASE WHEN s.primary_agent_id IS NULL THEN '待接待' ELSE '待回复' END END,
                     CASE WHEN s.pmc > 0 THEN '尺寸申请 ' || s.pmc || ' 件' END) AS description,
           'support_conversation'::text AS action, s.id AS target_id, s.card_sku AS sku_id, s.id AS conversation_id,
           CASE WHEN s.context->>'type' = 'product' THEN s.context->>'id' END AS listing_id
      FROM sup s WHERE s.needs_reply OR s.pmc > 0
    UNION ALL
    SELECT t.id, 'measurement', 'customers', t.created_at, '尺寸测量 ' || coalesce(k.name, ''),
           CASE WHEN t.status = 'claimed' THEN '测量中' ELSE '顾客申请测量，待处理' END,
           'measurement_task', t.id, t.sku_id, NULL::uuid, t.listing_id::text
      FROM product_measurement_tasks t LEFT JOIN inv_skus k ON k.id = t.sku_id, locs
     WHERE t.status IN ('pending','claimed') AND t.location_id = ANY (locs.ids)
       AND NOT EXISTS (SELECT 1 FROM support_messages m WHERE m.measurement_task_id = t.id AND m.card_kind = 'measurement_request')
    UNION ALL
    SELECT f.id, 'commerce_pick', 'orders', f.created_at, '商城拣货 ' || coalesce(o.order_no, f.code),
           CASE f.status WHEN 'picking' THEN '拣货中' WHEN 'exception' THEN '异常待处理' ELSE '待拣货' END,
           'fulfillment_detail', f.id, NULL::uuid, NULL::uuid, NULL::text
      FROM fulfillments f LEFT JOIN commerce_orders o ON o.id = f.order_id, locs
     WHERE f.status IN ('allocated','picking','exception') AND f.location_id = ANY (locs.ids)
    UNION ALL
    SELECT x.id, 'transfer_in', 'internal', coalesce(x.shipped_at, x.created_at), '调拨入库 ' || x.code,
           '共 ' || x.qty || ' 件，待验收入库', 'transfer_detail', x.id, NULL::uuid, NULL::uuid, NULL::text
      FROM stock_transfers x, locs
     WHERE x.status IN ('shipped','in_transit') AND x.to_location_id = ANY (locs.ids)
    UNION ALL
    SELECT st.id, 'stocktake', 'internal', st.opened_at, '盘点 ' || st.code, '盘点进行中，待提交',
           'stocktake_detail', st.id, NULL::uuid, NULL::uuid, NULL::text
      FROM stocktakes st, locs
     WHERE st.status IN ('open','scanning') AND st.location_id = ANY (locs.ids)
  ),
  counts AS (
    SELECT count(*) FILTER (WHERE cat = 'customers') AS customers, count(*) FILTER (WHERE cat = 'internal') AS internal,
           count(*) FILTER (WHERE cat = 'orders') AS orders, count(*) FILTER (WHERE cat = 'system') AS system
      FROM all_items
  ),
  page AS (
    SELECT * FROM all_items
     WHERE p_cursor_ts IS NULL OR (sort_ts, id) > (p_cursor_ts, p_cursor_id)
     ORDER BY sort_ts, id LIMIT greatest(coalesce(p_limit, 50), 0) + 1
  ),
  numbered AS (SELECT p.*, row_number() OVER (ORDER BY sort_ts, id) AS rn FROM page p)
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'type', type, 'title', title, 'description', description,
              'sort_ts', sort_ts, 'action', action, 'target_id', target_id, 'sku_id', sku_id,
              'conversation_id', conversation_id, 'listing_id', listing_id) ORDER BY rn)
              FROM numbered WHERE rn <= greatest(coalesce(p_limit, 50), 0)), '[]'::jsonb),
    'has_more', (SELECT count(*) FROM numbered) > greatest(coalesce(p_limit, 50), 0),
    'last_ts', (SELECT sort_ts FROM numbered WHERE rn = greatest(coalesce(p_limit, 50), 0)),
    'last_id', (SELECT id FROM numbered WHERE rn = greatest(coalesce(p_limit, 50), 0)),
    'counts', (SELECT jsonb_build_object('customers', customers, 'internal', internal, 'orders', orders, 'system', system,
               'total', customers + internal + orders + system) FROM counts))
$$;

CREATE OR REPLACE FUNCTION public.handheld_pending_counts(p_user_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.handheld_work_items(p_user_id, p_location_ids, p_include_unlocated, 0, NULL, NULL)->'counts'
$$;

REVOKE ALL ON FUNCTION public.measurement_attach_support(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_work_items(uuid, uuid[], boolean, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_pending_counts(uuid, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_attach_support(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_work_items(uuid, uuid[], boolean, integer, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_pending_counts(uuid, uuid[], boolean) TO service_role;

-- 回填：现存未完成任务的每个申请人关联会话卡片（幂等；不发语音，不伪造客户发言）
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT q.task_id, q.customer_id, q.created_at FROM product_measurement_requesters q
             JOIN product_measurement_tasks t ON t.id = q.task_id
            WHERE t.status IN ('pending','claimed') AND q.conversation_id IS NULL LOOP
    PERFORM public.measurement_attach_support(r.task_id, r.customer_id, r.created_at);
  END LOOP;
END $$;
