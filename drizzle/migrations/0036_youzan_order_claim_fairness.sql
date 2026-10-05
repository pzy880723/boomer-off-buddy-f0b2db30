-- Scheduling fairness only. Eligibility, lease fencing (FOR UPDATE SKIP LOCKED),
-- attempts<8, pending/error/expired-running filters, due-time filter and fixed
-- scan_end are unchanged. Today-priority now compares coverage against the
-- scannable cutoff least(window_end, now-5min) instead of the future window_end,
-- so a today window scanned within the last 5 minutes competes with historical
-- windows by next_run_at instead of starving them forever.
CREATE OR REPLACE FUNCTION public.youzan_claim_order_sync_cursor(p_worker_id text,p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.youzan_order_sync_cursors
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid;
BEGIN
  IF nullif(p_worker_id,'') IS NULL THEN RAISE EXCEPTION 'missing_lease_owner'; END IF;
  SELECT id INTO v_id FROM public.youzan_order_sync_cursors
  WHERE attempts < 8 AND next_run_at <= clock_timestamp()
    AND window_start < clock_timestamp()-interval '1 minute'
    AND (status IN ('pending','error') OR
      (status='running' AND lease_expires_at < clock_timestamp()))
  ORDER BY CASE WHEN
    window_end > (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
    AND window_start < ((date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai')
    AND (last_completed_scan_end IS NULL OR
         last_completed_scan_end < least(window_end, clock_timestamp()-interval '5 minutes'))
    THEN 0 ELSE 1 END,
    next_run_at ASC,window_start DESC,id ASC
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;
  RETURN QUERY UPDATE public.youzan_order_sync_cursors
  SET status='running',lease_owner=p_worker_id,
      lease_expires_at=clock_timestamp()+make_interval(secs=>greatest(30,least(p_lease_seconds,600))),
      scan_end=coalesce(scan_end,least(window_end,date_trunc('second',clock_timestamp()-interval '1 minute')))
  WHERE id=v_id RETURNING *;
END $$;
REVOKE ALL ON FUNCTION public.youzan_claim_order_sync_cursor(text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_claim_order_sync_cursor(text,integer) TO service_role;