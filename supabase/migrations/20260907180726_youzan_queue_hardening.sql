-- Queue-only hardening. Existing manual order sync keeps its current API.
ALTER TABLE public.youzan_order_sync_cursors
  DROP CONSTRAINT IF EXISTS youzan_order_sync_cursors_status_chk;
ALTER TABLE public.youzan_order_sync_cursors
  ADD COLUMN scan_end timestamptz,
  ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_completed_scan_end timestamptz,
  ADD COLUMN last_completed_at timestamptz;
ALTER TABLE public.youzan_orders ADD COLUMN source_updated_at timestamptz;

-- Old done rows did not prove complete coverage (some ran before window end).
-- Do not backfill completion watermarks from their status or finished_at logs.
UPDATE public.youzan_order_sync_cursors
SET status='pending',next_page=1,method_label=NULL,attempts=0
WHERE status='done';

CREATE OR REPLACE FUNCTION public.youzan_enqueue_order_sync_windows(p_windows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer;
BEGIN
  IF jsonb_typeof(p_windows) <> 'array' THEN RAISE EXCEPTION 'invalid_windows'; END IF;
  INSERT INTO public.youzan_order_sync_cursors(shop_id,window_start,window_end)
  SELECT shop_id,window_start,window_end
  FROM jsonb_to_recordset(p_windows) AS w(shop_id uuid,window_start timestamptz,window_end timestamptz)
  WHERE window_start < window_end
  ON CONFLICT (shop_id,window_start,window_end) DO UPDATE
  SET status='pending',next_page=1,method_label=NULL,scan_end=NULL,
      attempts=0,last_error=NULL,next_run_at=clock_timestamp()
  WHERE youzan_order_sync_cursors.status='done'
    AND coalesce(youzan_order_sync_cursors.last_completed_at,youzan_order_sync_cursors.last_progress_at,'-infinity')
        <= clock_timestamp()-interval '30 minutes';
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.youzan_enqueue_order_sync_windows(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_enqueue_order_sync_windows(jsonb) TO service_role;

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
  ORDER BY next_run_at ASC,window_start DESC,id ASC
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

-- Existing/manual rows predate source_updated_at. Compare their raw source
-- version too, without changing the manual write path or inventing freshness.
CREATE OR REPLACE FUNCTION public.youzan_order_raw_updated_at(p_raw jsonb)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE v text;
BEGIN
  WITH RECURSIVE nodes(value,depth) AS (
    SELECT p_raw,0
    UNION ALL
    SELECT e.value,n.depth+1 FROM nodes n
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
    WHERE n.depth<4 AND e.key IN ('full_order_info','fullOrderInfo','tradeBase','trade_base','trade','orderInfo','order_info','payInfo','pay_info')
  ) SELECT coalesce(value->>'modified',value->>'update_time',value->>'updateTime',value->>'updated_at',value->>'updatedAt')
    INTO v FROM nodes
    WHERE coalesce(value->>'modified',value->>'update_time',value->>'updateTime',value->>'updated_at',value->>'updatedAt') IS NOT NULL
    ORDER BY depth LIMIT 1;
  IF v ~ '^[0-9]{10}([0-9]{3})?$' THEN
    RETURN to_timestamp(v::numeric / CASE WHEN length(v)=13 THEN 1000 ELSE 1 END);
  ELSIF v ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN RETURN v::timestamptz;
  ELSE RETURN v::timestamp AT TIME ZONE 'Asia/Shanghai'; END IF;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.youzan_order_raw_updated_at(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_order_raw_updated_at(jsonb) TO service_role;

-- The cursor lock and every order upsert share one transaction. An expired
-- claimant cannot write even if its old HTTP response arrives after takeover.
CREATE OR REPLACE FUNCTION public.youzan_commit_order_sync_batch(p_cursor_id uuid,p_worker_id text,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.youzan_order_sync_cursors; r public.youzan_orders; accepted jsonb='[]'; v jsonb;
BEGIN
  SELECT * INTO c FROM public.youzan_order_sync_cursors WHERE id=p_cursor_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'running' OR c.lease_owner IS DISTINCT FROM p_worker_id
     OR c.lease_expires_at IS NULL OR c.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'lease_lost';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows)>20 THEN
    RAISE EXCEPTION 'invalid_order_batch';
  END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    r=jsonb_populate_record(NULL::public.youzan_orders,v);
    IF r.source_updated_at IS NULL THEN RAISE EXCEPTION 'missing_source_updated_at'; END IF;
    IF r.source_updated_at > clock_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'future_source_updated_at';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.youzan_shops WHERE id=r.shop_id AND kdt_id=r.kdt_id) THEN
      RAISE EXCEPTION 'invalid_order_shop';
    END IF;
    INSERT INTO public.youzan_orders AS stored (
      shop_id,kdt_id,tid,status,buyer_nick,payment,total_fee,num,pay_type,pay_time,created_time,raw,
      buyer_open_id,item_count,sku_count,item_titles,first_item_image,receiver_name,receiver_tel,
      receiver_address,outer_transaction_no,post_fee,status_text,source_updated_at
    ) VALUES (
      r.shop_id,r.kdt_id,r.tid,r.status,r.buyer_nick,r.payment,r.total_fee,r.num,r.pay_type,r.pay_time,r.created_time,r.raw,
      r.buyer_open_id,r.item_count,r.sku_count,r.item_titles,r.first_item_image,r.receiver_name,r.receiver_tel,
      r.receiver_address,r.outer_transaction_no,r.post_fee,r.status_text,r.source_updated_at
    ) ON CONFLICT (kdt_id,tid) DO UPDATE SET
      shop_id=excluded.shop_id,status=excluded.status,buyer_nick=excluded.buyer_nick,
      payment=excluded.payment,total_fee=excluded.total_fee,num=excluded.num,pay_type=excluded.pay_type,
      pay_time=excluded.pay_time,created_time=excluded.created_time,raw=excluded.raw,
      buyer_open_id=excluded.buyer_open_id,item_count=excluded.item_count,sku_count=excluded.sku_count,
      item_titles=excluded.item_titles,first_item_image=excluded.first_item_image,
      receiver_name=excluded.receiver_name,receiver_tel=excluded.receiver_tel,receiver_address=excluded.receiver_address,
      outer_transaction_no=excluded.outer_transaction_no,post_fee=excluded.post_fee,status_text=excluded.status_text,
      source_updated_at=excluded.source_updated_at
    WHERE greatest(stored.source_updated_at,public.youzan_order_raw_updated_at(stored.raw)) IS NULL
       OR greatest(stored.source_updated_at,public.youzan_order_raw_updated_at(stored.raw)) < excluded.source_updated_at;
    -- Equal-version replay is accepted for the existing idempotent inventory
    -- path, without updating local updated_at or overwriting the stored record.
    IF EXISTS (SELECT 1 FROM public.youzan_orders WHERE kdt_id=r.kdt_id AND tid=r.tid
      AND greatest(source_updated_at,public.youzan_order_raw_updated_at(raw))=r.source_updated_at) THEN
      accepted=accepted || jsonb_build_array(r.kdt_id::text || ':' || r.tid);
    END IF;
  END LOOP;
  RETURN accepted;
END $$;
REVOKE ALL ON FUNCTION public.youzan_commit_order_sync_batch(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_commit_order_sync_batch(uuid,text,jsonb) TO service_role;

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
    next_run_at=CASE WHEN open_scan THEN clock_timestamp()+interval '30 minutes'
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
