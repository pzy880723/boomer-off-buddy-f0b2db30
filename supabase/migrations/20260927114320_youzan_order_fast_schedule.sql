-- Scheduling only: retain eligibility, lease fencing, fixed scan_end and error backoff.
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
  -- UTC windows may straddle local midnight. Prioritize incomplete coverage of
  -- today in Shanghai, then preserve due-time fairness across shops/pages.
  ORDER BY CASE WHEN
    window_end > (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
    AND window_start < ((date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai')
    AND (last_completed_scan_end IS NULL OR last_completed_scan_end < window_end)
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

CREATE OR REPLACE FUNCTION public.youzan_advance_order_sync_cursor(
  p_cursor_id uuid,p_worker_id text,p_status text,p_next_page integer,p_method_label text,
  p_upserted integer,p_attempts integer,p_error text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.youzan_order_sync_cursors; open_scan boolean;
BEGIN
  IF p_status NOT IN ('pending','done','error','failed') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  SELECT * INTO c FROM public.youzan_order_sync_cursors WHERE id=p_cursor_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'running' OR c.lease_owner IS DISTINCT FROM p_worker_id
     OR c.lease_expires_at IS NULL OR c.lease_expires_at <= clock_timestamp() THEN RETURN false; END IF;
  IF c.scan_end IS NULL THEN RAISE EXCEPTION 'missing_scan_end'; END IF;
  open_scan=p_status='done' AND c.scan_end<c.window_end;
  UPDATE public.youzan_order_sync_cursors SET
    status=CASE WHEN open_scan THEN 'pending' ELSE p_status END,
    next_page=CASE WHEN open_scan THEN 1 ELSE greatest(1,coalesce(p_next_page,next_page)) END,
    method_label=CASE WHEN open_scan THEN NULL ELSE coalesce(p_method_label,method_label) END,
    scan_end=CASE WHEN open_scan THEN NULL ELSE scan_end END,
    next_run_at=CASE WHEN open_scan THEN clock_timestamp()+interval '1 minute'
                    WHEN p_status='error' THEN clock_timestamp()+interval '1 minute' ELSE clock_timestamp() END,
    last_completed_scan_end=CASE WHEN p_status='done' THEN c.scan_end ELSE last_completed_scan_end END,
    last_completed_at=CASE WHEN p_status='done' THEN clock_timestamp() ELSE last_completed_at END,
    total_upserted=total_upserted+greatest(0,coalesce(p_upserted,0)),
    attempts=greatest(0,coalesce(p_attempts,attempts)),last_error=p_error,
    lease_owner=NULL,lease_expires_at=NULL,
    last_progress_at=CASE WHEN p_status IN ('pending','done') THEN clock_timestamp() ELSE last_progress_at END
  WHERE id=p_cursor_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.youzan_advance_order_sync_cursor(uuid,text,text,integer,text,integer,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_advance_order_sync_cursor(uuid,text,text,integer,text,integer,integer,text) TO service_role;
