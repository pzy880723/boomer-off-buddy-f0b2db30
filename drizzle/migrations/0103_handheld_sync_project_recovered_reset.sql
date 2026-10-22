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
    SELECT count(*), min(l.id::text)::uuid INTO loc_count, loc
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
    DO UPDATE SET payload = EXCLUDED.payload, location_id = EXCLUDED.location_id, action_status = NULL;
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
     AND EXISTS (SELECT 1 FROM public.youzan_stock_sync_queue s
                  WHERE s.id = n.ref_id AND s.status = 'done');
  UPDATE public.inv_handheld_notifications n
     SET action_status = 'recovered'
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'channel_sync_outbox' AND n.action_status IS NULL
     AND EXISTS (SELECT 1 FROM public.channel_sync_outbox c
                  WHERE c.id = n.ref_id AND c.status = 'succeeded');
  UPDATE public.inv_handheld_notifications n
     SET action_status = NULL
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'stock_sync_queue' AND n.action_status = 'recovered'
     AND EXISTS (SELECT 1 FROM public.youzan_stock_sync_queue s
                  WHERE s.id = n.ref_id AND s.status = 'failed');
  UPDATE public.inv_handheld_notifications n
     SET action_status = NULL
   WHERE n.kind = 'youzan_sync_failed' AND n.ref_type = 'channel_sync_outbox' AND n.action_status = 'recovered'
     AND EXISTS (SELECT 1 FROM public.channel_sync_outbox c
                  WHERE c.id = n.ref_id AND c.status IN ('failed', 'dead', 'dead_letter'));
  RETURN total;
END
$function$;
REVOKE ALL ON FUNCTION public.handheld_sync_failure_reconcile(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_sync_failure_reconcile(integer, integer) TO service_role;