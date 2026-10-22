-- 待办 + 通知修复（backend only）：
-- 1) handheld_work_items 移除 stock_sync/channel_sync 系统异常分支（待办只保留人工操作）；
-- 2) 同步失败投影为真实 inv_handheld_notifications（复用既有 kind='youzan_sync_failed'，
--    幂等回填近 7 天 + 状态触发器持续投影，缺/歧义门店不广播；恢复时 action_status='recovered' 保留历史）；
-- 3) measurement_task_dismissals 个人忽略（service-role only，按 request_version 区分复用任务）。

-- 3a) 测量个人忽略表
CREATE TABLE public.measurement_task_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.product_measurement_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  request_version timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, user_id, request_version)
);
GRANT ALL ON public.measurement_task_dismissals TO service_role;
REVOKE ALL ON public.measurement_task_dismissals FROM PUBLIC, anon, authenticated;
ALTER TABLE public.measurement_task_dismissals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "measurement dismissals are backend only"
  ON public.measurement_task_dismissals TO service_role USING (true) WITH CHECK (true);

-- 任务当前「关注版本」：最新测量请求事件（客服卡片或 requester 行），兜底任务创建时间。
-- active SKU 任务可被复用，新版本请求会推进该版本，旧版本的忽略不会吞掉新请求。
CREATE OR REPLACE FUNCTION public.measurement_task_request_version(p_task_id uuid)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$
  SELECT greatest(
    coalesce((SELECT max(m.created_at) FROM public.support_messages m
               WHERE m.measurement_task_id = p_task_id AND m.card_kind = 'measurement_request'),
             '-infinity'::timestamptz),
    coalesce((SELECT max(q.created_at) FROM public.product_measurement_requesters q
               WHERE q.task_id = p_task_id),
             '-infinity'::timestamptz),
    t.created_at)
  FROM public.product_measurement_tasks t
  WHERE t.id = p_task_id
$function$;
REVOKE ALL ON FUNCTION public.measurement_task_request_version(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_task_request_version(uuid) TO service_role;

-- 忽略：单次调用内原子校验任务存在/门店归属/状态/版本，幂等插入。
CREATE OR REPLACE FUNCTION public.measurement_task_dismiss(
  p_task_id uuid, p_user_id uuid, p_location_id uuid, p_request_version timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS
$function$
DECLARE t record; cur timestamptz;
BEGIN
  SELECT id, location_id, status INTO t FROM public.product_measurement_tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF t.location_id IS DISTINCT FROM p_location_id THEN
    RAISE EXCEPTION 'task_location_mismatch' USING ERRCODE = 'P0003';
  END IF;
  IF t.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'task_closed' USING ERRCODE = 'P0009';
  END IF;
  cur := public.measurement_task_request_version(p_task_id);
  IF cur IS DISTINCT FROM p_request_version THEN
    RAISE EXCEPTION 'stale_request_version:%',
      to_char(cur AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') USING ERRCODE = 'P0010';
  END IF;
  INSERT INTO public.measurement_task_dismissals(task_id, user_id, location_id, request_version)
  VALUES (p_task_id, p_user_id, p_location_id, cur)
  ON CONFLICT (task_id, user_id, request_version) DO NOTHING;
  RETURN jsonb_build_object('dismissed', true, 'task_id', p_task_id,
    'request_version', to_char(cur AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END
$function$;
REVOKE ALL ON FUNCTION public.measurement_task_dismiss(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_task_dismiss(uuid, uuid, uuid, timestamptz) TO service_role;

-- 撤销忽略：幂等删除；同样校验任务归属（防跨店探测），已完结任务允许撤销以便恢复历史视图。
CREATE OR REPLACE FUNCTION public.measurement_task_undismiss(
  p_task_id uuid, p_user_id uuid, p_location_id uuid, p_request_version timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS
$function$
DECLARE t record;
BEGIN
  SELECT id, location_id INTO t FROM public.product_measurement_tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF t.location_id IS DISTINCT FROM p_location_id THEN
    RAISE EXCEPTION 'task_location_mismatch' USING ERRCODE = 'P0003';
  END IF;
  DELETE FROM public.measurement_task_dismissals
   WHERE task_id = p_task_id AND user_id = p_user_id AND request_version = p_request_version;
  RETURN jsonb_build_object('dismissed', false, 'task_id', p_task_id,
    'request_version', to_char(p_request_version AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
END
$function$;
REVOKE ALL ON FUNCTION public.measurement_task_undismiss(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_task_undismiss(uuid, uuid, uuid, timestamptz) TO service_role;

-- 2a) 同步失败通知：去重索引 + 投影函数 + 触发器 + 回填
CREATE UNIQUE INDEX uidx_handheld_notif_yzsync_ref
  ON public.inv_handheld_notifications (kind, ref_id)
  WHERE kind = 'youzan_sync_failed';

-- 单条投影：failed → 幂等 upsert 通知；恢复/终结 → action_status='recovered'（保留历史）。
-- 门店解析：优先队列 location_id 并校验其与 shop_id 的映射；否则按 shop_id 反查唯一启用门店；
-- 缺失或歧义（0 家 / 多家）时直接跳过——绝不广播到所有门店。
CREATE OR REPLACE FUNCTION public.handheld_sync_failure_project(p_queue text, p_row_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS
$function$
DECLARE
  q record; loc uuid; loc_count integer;
  v_ref text; v_failed boolean; v_recovered boolean; v_sku_name text;
BEGIN
  IF p_queue = 'stock' THEN
    SELECT s.sku_id, s.shop_id, s.location_id, s.status, s.attempts, s.last_error, s.created_at
      INTO q FROM public.youzan_stock_sync_queue s WHERE s.id = p_row_id;
    v_ref := 'stock_sync_queue';
    v_failed := q.status = 'failed';
    v_recovered := q.status IN ('done', 'cancelled');
  ELSIF p_queue = 'channel' THEN
    SELECT c.sku_id, c.shop_id, NULL::uuid AS location_id, c.status, c.attempts, c.last_error, c.created_at
      INTO q FROM public.channel_sync_outbox c WHERE c.id = p_row_id;
    v_ref := 'channel_sync_outbox';
    v_failed := q.status IN ('failed', 'dead', 'dead_letter');
    v_recovered := q.status IN ('succeeded', 'superseded', 'cancelled');
  ELSE
    RETURN;
  END IF;
  IF q IS NULL THEN RETURN; END IF;

  loc := NULL;
  IF q.location_id IS NOT NULL THEN
    SELECT l.id INTO loc FROM public.inv_locations l
     WHERE l.id = q.location_id AND (q.shop_id IS NULL OR l.shop_id = q.shop_id);
  END IF;
  IF loc IS NULL AND q.shop_id IS NOT NULL THEN
    SELECT count(*), min(l.id) INTO loc_count, loc
      FROM public.inv_locations l WHERE l.shop_id = q.shop_id AND l.is_active;
    IF loc_count <> 1 THEN loc := NULL; END IF;
  END IF;

  IF v_failed THEN
    IF loc IS NULL THEN RETURN; END IF;
    SELECT name INTO v_sku_name FROM public.inv_skus WHERE id = q.sku_id;
    INSERT INTO public.inv_handheld_notifications
      (kind, title, payload, location_id, audience, action_status, ref_type, ref_id, ts)
    VALUES (
      'youzan_sync_failed',
      (CASE WHEN p_queue = 'stock' THEN '库存同步失败：' ELSE '渠道同步失败：' END) || coalesce(v_sku_name, '未知商品'),
      jsonb_build_object(
        'ref_id', p_row_id, 'sku_id', q.sku_id, 'sku_name', v_sku_name,
        'queue', p_queue, 'status', q.status, 'attempts', q.attempts,
        'reason', left(coalesce(q.last_error, ''), 200), 'action', 'sync_center'),
      loc, 'location', NULL, v_ref, p_row_id, q.created_at)
    ON CONFLICT (kind, ref_id) WHERE kind = 'youzan_sync_failed'
    DO UPDATE SET payload = EXCLUDED.payload, location_id = EXCLUDED.location_id;
  ELSIF v_recovered THEN
    UPDATE public.inv_handheld_notifications
       SET action_status = 'recovered',
           payload = payload || jsonb_build_object('status', q.status)
     WHERE kind = 'youzan_sync_failed' AND ref_id = p_row_id AND action_status IS DISTINCT FROM 'recovered';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION public.handheld_sync_failure_project(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_sync_failure_project(text, uuid) TO service_role;

-- 状态翻转触发器：仅 status 列变化时触发（attempts 自增不重复轰炸）。
CREATE OR REPLACE FUNCTION public.tg_handheld_sync_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS
$function$
BEGIN
  IF TG_TABLE_NAME = 'youzan_stock_sync_queue' THEN
    PERFORM public.handheld_sync_failure_project('stock', NEW.id);
  ELSIF TG_TABLE_NAME = 'channel_sync_outbox' THEN
    PERFORM public.handheld_sync_failure_project('channel', NEW.id);
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.tg_handheld_sync_notify() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_handheld_sync_notify() TO service_role;

CREATE TRIGGER trg_yz_stock_sync_notify
  AFTER INSERT OR UPDATE OF status ON public.youzan_stock_sync_queue
  FOR EACH ROW EXECUTE FUNCTION public.tg_handheld_sync_notify();
CREATE TRIGGER trg_cso_sync_notify
  AFTER INSERT OR UPDATE OF status ON public.channel_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_handheld_sync_notify();

-- 幂等回填/补偿：近 N 天 failed 且尚无通知的队列行 → 投影；通知仍在但队列已恢复 → recovered。
-- created_at 窗口天然排除 8 月遗留测试队列（不触碰）。
CREATE OR REPLACE FUNCTION public.handheld_sync_failure_reconcile(p_days integer DEFAULT 7, p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS
$function$
DECLARE r record; total integer := 0;
BEGIN
  FOR r IN
    SELECT 'stock' AS q, s.id FROM public.youzan_stock_sync_queue s
     WHERE s.status = 'failed'
       AND s.created_at >= now() - make_interval(days => greatest(1, least(p_days, 30)))
       AND NOT EXISTS (SELECT 1 FROM public.inv_handheld_notifications n
                        WHERE n.kind = 'youzan_sync_failed' AND n.ref_id = s.id)
    UNION ALL
    SELECT 'channel', c.id FROM public.channel_sync_outbox c
     WHERE c.status IN ('failed', 'dead', 'dead_letter')
       AND c.created_at >= now() - make_interval(days => greatest(1, least(p_days, 30)))
       AND NOT EXISTS (SELECT 1 FROM public.inv_handheld_notifications n
                        WHERE n.kind = 'youzan_sync_failed' AND n.ref_id = c.id)
    LIMIT greatest(1, least(p_limit, 500))
  LOOP
    BEGIN
      PERFORM public.handheld_sync_failure_project(r.q, r.id);
      total := total + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'sync failure reconcile failed: %', SQLSTATE;
    END;
  END LOOP;
  UPDATE public.inv_handheld_notifications n
     SET action_status = 'recovered'
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'stock_sync_queue' AND n.action_status IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.youzan_stock_sync_queue s
                      WHERE s.id = n.ref_id AND s.status = 'failed');
  UPDATE public.inv_handheld_notifications n
     SET action_status = 'recovered'
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'channel_sync_outbox' AND n.action_status IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.channel_sync_outbox c
                      WHERE c.id = n.ref_id AND c.status IN ('failed', 'dead', 'dead_letter'));
  RETURN total;
END
$function$;
REVOKE ALL ON FUNCTION public.handheld_sync_failure_reconcile(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_sync_failure_reconcile(integer, integer) TO service_role;

-- 一次性回填（近 7 天失败队列 → 通知；幂等，可重复执行）。
SELECT public.handheld_sync_failure_reconcile(7, 500);

-- 列表 category 服务端过滤用的种类枚举（配合 TS 端口 notificationKindCategory）。
CREATE OR REPLACE FUNCTION public.handheld_notification_kinds()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$
  SELECT coalesce(array_agg(DISTINCT kind), '{}'::text[]) FROM public.inv_handheld_notifications
$function$;
REVOKE ALL ON FUNCTION public.handheld_notification_kinds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notification_kinds() TO service_role;

-- 1) handheld_work_items：移除 stock_sync/channel_sync 分支；
--    测量行加 measurement_task_id / measurement_request_version / can_ignore / ignored；
--    新增 p_include_ignored / p_ignored_only（默认 false，旧调用不变）。
DROP FUNCTION public.handheld_work_items(uuid, uuid[], boolean, integer, timestamptz, uuid);

CREATE FUNCTION public.handheld_work_items(
  p_user_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false,
  p_limit integer DEFAULT 50, p_cursor_ts timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL,
  p_include_ignored boolean DEFAULT false, p_ignored_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$
WITH locs AS(SELECT coalesce(p_location_ids,'{}'::uuid[]) ids),
cards AS(
  SELECT m.conversation_id,m.measurement_task_id,t.created_at,t.listing_id,t.sku_id,
         EXISTS(SELECT 1 FROM public.measurement_task_dismissals d
                 WHERE d.task_id=t.id AND d.user_id=p_user_id
                   AND d.request_version=public.measurement_task_request_version(t.id)) AS ignored
    FROM support_messages m
    JOIN product_measurement_tasks t ON t.id=m.measurement_task_id
    JOIN support_conversations sc ON sc.id=m.conversation_id AND sc.location_id=t.location_id
    JOIN product_measurement_requesters q ON q.task_id=t.id AND q.customer_id=sc.customer_id AND q.conversation_id=sc.id
   WHERE m.card_kind='measurement_request' AND t.status IN ('pending','claimed')),
vis_cards AS(SELECT * FROM cards WHERE p_include_ignored OR NOT ignored),
sup AS(
  SELECT sc.*,
         (SELECT count(*) FROM vis_cards c WHERE c.conversation_id=sc.id AND (NOT p_ignored_only OR c.ignored)) pmc,
         (SELECT min(c.created_at) FROM vis_cards c WHERE c.conversation_id=sc.id) card_at,
         (SELECT c.sku_id FROM vis_cards c WHERE c.conversation_id=sc.id ORDER BY c.created_at LIMIT 1) card_sku,
         public.support_needs_reply(sc.id) needs_reply
    FROM support_conversations sc,locs
   WHERE sc.location_id=ANY(locs.ids) OR(p_include_unlocated AND sc.location_id IS NULL)),
all_items AS(
  SELECT s.id,'support'::text type,'customers'::text cat,
         coalesce(least(s.waiting_since,s.card_at),s.waiting_since,s.card_at,s.created_at) sort_ts,
         coalesce(s.title,'客户咨询') title,
         concat_ws(' · ',
           CASE WHEN s.needs_reply AND NOT p_ignored_only THEN CASE WHEN s.primary_agent_id IS NULL THEN '待接待' ELSE '待回复' END END,
           CASE WHEN s.pmc>0 THEN '尺寸申请 '||s.pmc||' 件' END) description,
         'support_conversation'::text action,s.id target_id,s.card_sku sku_id,s.id conversation_id,
         CASE WHEN s.context->>'type'='product' THEN s.context->>'id' END listing_id,
         NULL::uuid measurement_task_id,NULL::text measurement_request_version,false can_ignore,false ignored
    FROM sup s
   WHERE (s.needs_reply AND NOT p_ignored_only) OR s.pmc>0
  UNION ALL
  SELECT t.id,'measurement','customers',t.created_at,'尺寸测量 '||coalesce(k.name,''),
         CASE WHEN t.status='claimed' THEN '测量中' ELSE '顾客申请测量，待处理' END,
         'measurement_task',t.id,t.sku_id,NULL::uuid,t.listing_id::text,
         t.id,
         to_char(public.measurement_task_request_version(t.id) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         NOT ign.ignored, ign.ignored
    FROM product_measurement_tasks t
    LEFT JOIN inv_skus k ON k.id=t.sku_id
    CROSS JOIN LATERAL (
      SELECT EXISTS(SELECT 1 FROM public.measurement_task_dismissals d
                     WHERE d.task_id=t.id AND d.user_id=p_user_id
                       AND d.request_version=public.measurement_task_request_version(t.id)) AS ignored
    ) ign, locs
   WHERE t.status IN ('pending','claimed')
     AND (t.location_id=ANY(locs.ids) OR (p_include_unlocated AND t.location_id IS NULL))
     AND NOT EXISTS(SELECT 1 FROM cards c WHERE c.measurement_task_id=t.id)
     AND ((p_ignored_only AND ign.ignored) OR (NOT p_ignored_only AND (p_include_ignored OR NOT ign.ignored)))
  UNION ALL
  SELECT f.id,'commerce_pick','orders',f.created_at,'商城拣货 '||coalesce(o.order_no,f.code),
         CASE WHEN o.fulfillment_method='pickup' THEN '自提待备货/领取'
              WHEN f.status IN ('picked','packing','packed','handover_ready') THEN '待发货/交接'
              WHEN f.status='picking' THEN '拣货中' ELSE '待备货/异常处理' END,
         'fulfillment_detail',f.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false
    FROM fulfillments f JOIN commerce_orders o ON o.id=f.order_id,locs
   WHERE NOT p_ignored_only
     AND f.status IN ('unallocated','allocated','picking','picked','packing','packed','handover_ready','exception')
     AND f.location_id=ANY(locs.ids)
     AND o.order_status NOT IN ('cancelled','closed')
     AND o.payment_status IN ('paid','refund_pending','partially_refunded')
  UNION ALL
  SELECT x.id,CASE WHEN x.status IN ('shipped','in_transit') THEN 'transfer_in' ELSE 'transfer_out' END,'internal',
         coalesce(x.shipped_at,x.created_at),'调拨入库 '||x.code,'共 '||x.qty||' 件，待验收入库',
         'transfer_detail',x.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false
    FROM stock_transfers x,locs
   WHERE NOT p_ignored_only
     AND ((x.status IN ('shipped','in_transit') AND x.to_location_id=ANY(locs.ids))
       OR (x.status IN ('draft','approved','failed') AND x.from_location_id=ANY(locs.ids)))
  UNION ALL
  SELECT st.id,'stocktake','internal',coalesce(st.opened_at,st.created_at),'盘点 '||st.code,'盘点进行中，待提交',
         'stocktake_detail',st.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false
    FROM stocktakes st,locs
   WHERE NOT p_ignored_only AND st.status IN ('open','scanning','submitted') AND st.location_id=ANY(locs.ids)
  UNION ALL
  SELECT a.id,'after_sale','orders',a.created_at,'售后 '||coalesce(a.after_sale_no,''),'待处理售后',
         'after_sale_detail',a.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false
    FROM commerce_after_sales a,locs
   WHERE NOT p_ignored_only
     AND a.status IN ('requested','store_reviewing','store_received','inspecting','refund_pending')
     AND a.location_id=ANY(locs.ids)
),
counts AS(
  SELECT count(*) FILTER(WHERE cat='customers') customers,
         count(*) FILTER(WHERE cat='internal') internal,
         count(*) FILTER(WHERE cat='orders') orders,
         count(*) FILTER(WHERE cat='system') system
    FROM all_items),
page AS(
  SELECT * FROM all_items
   WHERE p_cursor_ts IS NULL OR (sort_ts,id)>(p_cursor_ts,p_cursor_id)
   ORDER BY sort_ts,id LIMIT greatest(coalesce(p_limit,50),0)+1),
numbered AS(SELECT p.*,row_number() OVER(ORDER BY sort_ts,id) rn FROM page p)
SELECT jsonb_build_object(
  'items',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',id,'type',type,'title',title,'description',description,'sort_ts',sort_ts,
      'action',action,'target_id',target_id,'sku_id',sku_id,'conversation_id',conversation_id,
      'listing_id',listing_id,'measurement_task_id',measurement_task_id,
      'measurement_request_version',measurement_request_version,
      'can_ignore',can_ignore,'ignored',ignored) ORDER BY rn)
    FROM numbered WHERE rn<=greatest(coalesce(p_limit,50),0)),'[]'::jsonb),
  'has_more',(SELECT count(*) FROM numbered)>greatest(coalesce(p_limit,50),0),
  'last_ts',(SELECT sort_ts FROM numbered WHERE rn=greatest(coalesce(p_limit,50),0)),
  'last_id',(SELECT id FROM numbered WHERE rn=greatest(coalesce(p_limit,50),0)),
  'counts',(SELECT jsonb_build_object('customers',customers,'internal',internal,'orders',orders,'system',system,
                                      'total',customers+internal+orders+system) FROM counts))
$function$;
REVOKE ALL ON FUNCTION public.handheld_work_items(uuid, uuid[], boolean, integer, timestamptz, uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_work_items(uuid, uuid[], boolean, integer, timestamptz, uuid, boolean, boolean) TO service_role;