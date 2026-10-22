-- scoped 待办对齐 0099/0100（真实线上路径是 handheld_work_items_scoped / handheld_pending_counts_scoped）：
-- 1) 移除 stock_sync/channel_sync 系统异常分支（今日待办只保留人工操作；同步失败走 inv_handheld_notifications 投影）；
-- 2) 测量逐任务输出（含带客服卡任务），携带 measurement_task_id / measurement_request_version / can_ignore / ignored / can_restore；
--    support 行仅保留真实普通待回复（needs_reply），避免与逐任务测量行重复计数；
-- 3) 新增 p_include_ignored / p_ignored_only（DEFAULT false，旧 8 参调用语义不变）；
-- 4) 带卡测量任务对「已授权客服 scope」可见（conversation_id 回带），孤立测量仍只走通用业务 scope——客服权限绝不扩大业务权限。
-- 忽略数据复用 0099 的 measurement_task_dismissals + measurement_task_request_version（按请求版本区分复用任务）。

DROP FUNCTION public.handheld_work_items_scoped(uuid, uuid[], boolean, integer, timestamptz, uuid, uuid[], boolean);

CREATE OR REPLACE FUNCTION public.handheld_work_items_scoped(
  p_user_id uuid,
  p_location_ids uuid[],
  p_include_unlocated boolean DEFAULT false,
  p_limit integer DEFAULT 50,
  p_cursor_ts timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_support_location_ids uuid[] DEFAULT NULL,
  p_support_include_unlocated boolean DEFAULT NULL,
  p_include_ignored boolean DEFAULT false,
  p_ignored_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$
WITH locs AS(SELECT coalesce(p_location_ids,'{}'::uuid[]) ids),
cards AS(
  SELECT m.conversation_id,m.measurement_task_id,t.created_at,t.listing_id,t.sku_id,sc.location_id conv_location
    FROM support_messages m
    JOIN product_measurement_tasks t ON t.id=m.measurement_task_id
    JOIN support_conversations sc ON sc.id=m.conversation_id AND sc.location_id=t.location_id
    JOIN product_measurement_requesters q ON q.task_id=t.id AND q.customer_id=sc.customer_id AND q.conversation_id=sc.id
   WHERE m.card_kind='measurement_request' AND t.status IN ('pending','claimed')),
vis_cards AS(
  SELECT c.* FROM cards c,locs
   WHERE c.conv_location=ANY(coalesce(p_support_location_ids,locs.ids))
      OR (coalesce(p_support_include_unlocated,p_include_unlocated) AND c.conv_location IS NULL)),
sup AS(
  SELECT sc.*,(SELECT count(*) FROM cards c WHERE c.conversation_id=sc.id) pmc,
         (SELECT min(c.created_at) FROM cards c WHERE c.conversation_id=sc.id) card_at,
         (SELECT c.sku_id FROM cards c WHERE c.conversation_id=sc.id ORDER BY c.created_at LIMIT 1) card_sku,
         public.support_needs_reply(sc.id) needs_reply
    FROM support_conversations sc,locs
   WHERE sc.location_id=ANY(coalesce(p_support_location_ids,locs.ids))
      OR (coalesce(p_support_include_unlocated,p_include_unlocated) AND sc.location_id IS NULL)),
all_items AS(
  SELECT s.id,'support'::text type,'customers'::text cat,
         coalesce(least(s.waiting_since,s.card_at),s.waiting_since,s.card_at,s.created_at) sort_ts,
         coalesce(s.title,'客户咨询') title,
         concat_ws(' · ',CASE WHEN s.needs_reply THEN CASE WHEN s.primary_agent_id IS NULL THEN '待接待' ELSE '待回复' END END,
                   CASE WHEN s.pmc>0 THEN '尺寸申请 '||s.pmc||' 件' END) description,
         'support_conversation'::text action,s.id target_id,s.card_sku sku_id,s.id conversation_id,
         CASE WHEN s.context->>'type'='product' THEN s.context->>'id' END listing_id,
         NULL::uuid measurement_task_id,NULL::text measurement_request_version,
         false can_ignore,false ignored,false can_restore
    FROM sup s
   WHERE s.needs_reply AND NOT p_ignored_only
  UNION ALL
  SELECT t.id,'measurement','customers',t.created_at,'尺寸测量 '||coalesce(k.name,''),
         CASE WHEN t.status='claimed' THEN '测量中' ELSE '顾客申请测量，待处理' END,
         'measurement_task',t.id,t.sku_id,
         (SELECT c.conversation_id FROM vis_cards c WHERE c.measurement_task_id=t.id ORDER BY c.created_at LIMIT 1),
         t.listing_id::text,
         t.id,
         to_char(public.measurement_task_request_version(t.id) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         NOT ign.ignored, ign.ignored, ign.ignored
    FROM product_measurement_tasks t
    LEFT JOIN inv_skus k ON k.id=t.sku_id
    CROSS JOIN LATERAL (
      SELECT EXISTS(SELECT 1 FROM public.measurement_task_dismissals d
                     WHERE d.task_id=t.id AND d.user_id=p_user_id
                       AND d.request_version=public.measurement_task_request_version(t.id)) AS ignored
    ) ign, locs
   WHERE t.status IN ('pending','claimed')
     AND (t.location_id=ANY(locs.ids)
          OR (p_include_unlocated AND t.location_id IS NULL)
          OR EXISTS(SELECT 1 FROM vis_cards c WHERE c.measurement_task_id=t.id))
     AND ((p_ignored_only AND ign.ignored) OR (NOT p_ignored_only AND (p_include_ignored OR NOT ign.ignored)))
  UNION ALL
  SELECT f.id,'commerce_pick','orders',f.created_at,'商城拣货 '||coalesce(o.order_no,f.code),
         CASE WHEN o.fulfillment_method='pickup' THEN '自提待备货/领取'
              WHEN f.status IN ('picked','packing','packed','handover_ready') THEN '待发货/交接'
              WHEN f.status='picking' THEN '拣货中' ELSE '待备货/异常处理' END,
         'fulfillment_detail',f.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false,false
    FROM fulfillments f JOIN commerce_orders o ON o.id=f.order_id,locs
   WHERE NOT p_ignored_only
     AND f.status IN ('unallocated','allocated','picking','picked','packing','packed','handover_ready','exception')
     AND f.location_id=ANY(locs.ids)
     AND o.order_status NOT IN ('cancelled','closed')
     AND o.payment_status IN ('paid','refund_pending','partially_refunded')
  UNION ALL
  SELECT x.id,CASE WHEN x.status IN ('shipped','in_transit') THEN 'transfer_in' ELSE 'transfer_out' END,'internal',
         coalesce(x.shipped_at,x.created_at),'调拨入库 '||x.code,'共 '||x.qty||' 件，待验收入库',
         'transfer_detail',x.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false,false
    FROM stock_transfers x,locs
   WHERE NOT p_ignored_only
     AND ((x.status IN ('shipped','in_transit') AND x.to_location_id=ANY(locs.ids))
       OR (x.status IN ('draft','approved','failed') AND x.from_location_id=ANY(locs.ids)))
  UNION ALL
  SELECT st.id,'stocktake','internal',coalesce(st.opened_at,st.created_at),'盘点 '||st.code,'盘点进行中，待提交',
         'stocktake_detail',st.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false,false
    FROM stocktakes st,locs
   WHERE NOT p_ignored_only AND st.status IN ('open','scanning','submitted') AND st.location_id=ANY(locs.ids)
  UNION ALL
  SELECT a.id,'after_sale','orders',a.created_at,'售后 '||coalesce(a.after_sale_no,''),'待处理售后',
         'after_sale_detail',a.id,NULL::uuid,NULL::uuid,NULL::text,NULL::uuid,NULL::text,false,false,false
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
      'can_ignore',can_ignore,'ignored',ignored,'can_restore',can_restore) ORDER BY rn)
    FROM numbered WHERE rn<=greatest(coalesce(p_limit,50),0)),'[]'::jsonb),
  'has_more',(SELECT count(*) FROM numbered)>greatest(coalesce(p_limit,50),0),
  'last_ts',(SELECT sort_ts FROM numbered WHERE rn=greatest(coalesce(p_limit,50),0)),
  'last_id',(SELECT id FROM numbered WHERE rn=greatest(coalesce(p_limit,50),0)),
  'counts',(SELECT jsonb_build_object('customers',customers,'internal',internal,'orders',orders,'system',system,
                                      'total',customers+internal+orders+system) FROM counts))
$function$;

-- count-only 包装保持 5 参旧合同：默认不含已忽略（与 8 参旧调用语义一致）。
CREATE OR REPLACE FUNCTION public.handheld_pending_counts_scoped(
  p_user_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false,
  p_support_location_ids uuid[] DEFAULT NULL, p_support_include_unlocated boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$
  SELECT public.handheld_work_items_scoped(
    p_user_id, p_location_ids, p_include_unlocated, 0, NULL, NULL,
    p_support_location_ids, p_support_include_unlocated, false, false)->'counts'
$function$;

REVOKE ALL ON FUNCTION public.handheld_work_items_scoped(uuid, uuid[], boolean, integer, timestamptz, uuid, uuid[], boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_pending_counts_scoped(uuid, uuid[], boolean, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_work_items_scoped(uuid, uuid[], boolean, integer, timestamptz, uuid, uuid[], boolean, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_pending_counts_scoped(uuid, uuid[], boolean, uuid[], boolean) TO service_role;