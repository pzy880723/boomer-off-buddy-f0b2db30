CREATE OR REPLACE FUNCTION public.handheld_mask_error(p text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS
$function$
  SELECT left(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
    'https?://\S+', '[url]', 'g'),
    '[A-Za-z0-9_\-]{24,}', '[token]', 'g'),
    '[0-9]{7,}', '[number]', 'g'), 200)
$function$;
REVOKE ALL ON FUNCTION public.handheld_mask_error(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_mask_error(text) TO service_role;

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
    v_recovered := q.status = 'done';
  ELSIF p_queue = 'channel' THEN
    SELECT c.sku_id, c.shop_id, NULL::uuid AS location_id, c.status, c.attempts, c.last_error, c.created_at
      INTO q FROM public.channel_sync_outbox c WHERE c.id = p_row_id;
    v_ref := 'channel_sync_outbox';
    v_failed := q.status IN ('failed', 'dead', 'dead_letter');
    v_recovered := q.status = 'succeeded';
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
        'reason', public.handheld_mask_error(q.last_error), 'action', 'sync_center'),
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
  -- 恢复只认真实终态：stock=done / channel=succeeded；重试中(pending/running)与 cancelled/superseded 都不算恢复。
  UPDATE public.inv_handheld_notifications n
     SET action_status = 'recovered'
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'stock_sync_queue' AND n.action_status IS NULL
     AND EXISTS (SELECT 1 FROM public.youzan_stock_sync_queue s
                  WHERE s.id = n.ref_id AND s.status = 'done');
  UPDATE public.inv_handheld_notifications n
     SET action_status = 'recovered'
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'channel_sync_outbox' AND n.action_status IS NULL
     AND EXISTS (SELECT 1 FROM public.channel_sync_outbox c
                  WHERE c.id = n.ref_id AND c.status = 'succeeded');
  RETURN total;
END
$function$;

CREATE OR REPLACE FUNCTION public.handheld_work_items(
  p_user_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false,
  p_limit integer DEFAULT 50, p_cursor_ts timestamptz DEFAULT NULL, p_cursor_id uuid DEFAULT NULL,
  p_include_ignored boolean DEFAULT false, p_ignored_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$
WITH locs AS(SELECT coalesce(p_location_ids,'{}'::uuid[]) ids),
sup AS(
  SELECT sc.*, public.support_needs_reply(sc.id) needs_reply
    FROM support_conversations sc,locs
   WHERE sc.location_id=ANY(locs.ids) OR(p_include_unlocated AND sc.location_id IS NULL)),
all_items AS(
  SELECT s.id,'support'::text type,'customers'::text cat,
         coalesce(s.waiting_since,s.created_at) sort_ts,
         coalesce(s.title,'客户咨询') title,
         CASE WHEN s.primary_agent_id IS NULL THEN '待接待' ELSE '待回复' END description,
         'support_conversation'::text action,s.id target_id,NULL::uuid sku_id,s.id conversation_id,
         CASE WHEN s.context->>'type'='product' THEN s.context->>'id' END listing_id,
         NULL::uuid measurement_task_id,NULL::text measurement_request_version,false can_ignore,false ignored,false can_restore
    FROM sup s
   WHERE s.needs_reply AND NOT p_ignored_only
  UNION ALL
  SELECT t.id,'measurement','customers',t.created_at,'尺寸测量 '||coalesce(k.name,''),
         CASE WHEN t.status='claimed' THEN '测量中' ELSE '顾客申请测量，待处理' END,
         'measurement_task',t.id,t.sku_id,NULL::uuid,t.listing_id::text,
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
     AND (t.location_id=ANY(locs.ids) OR (p_include_unlocated AND t.location_id IS NULL))
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