-- 渠道同步队列：过期租约可重取、按 sku/action 限定的 canary 领取、带 worker fencing 的完成写入。
CREATE OR REPLACE FUNCTION public.claim_channel_sync_tasks_v2(
  p_worker_id text, p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 60,
  p_sku_id uuid DEFAULT NULL, p_action text DEFAULT NULL)
RETURNS SETOF public.channel_sync_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN RAISE EXCEPTION 'worker_id required'; END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM public.channel_sync_outbox
     WHERE ((status IN ('pending','retry_wait') AND next_run_at <= now())
            OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()))
       AND (p_sku_id IS NULL OR sku_id = p_sku_id)
       AND (p_action IS NULL OR action = p_action)
     ORDER BY priority ASC, next_run_at ASC
     LIMIT greatest(1, least(p_limit, 100))
     FOR UPDATE SKIP LOCKED)
  UPDATE public.channel_sync_outbox o
     SET status = 'running', worker_id = p_worker_id, claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => greatest(15, least(p_lease_seconds, 300))),
         attempts = o.attempts + 1, updated_at = now()
    FROM picked WHERE o.id = picked.id
  RETURNING o.*;
END $$;

CREATE OR REPLACE FUNCTION public.finish_channel_sync_task(
  p_id uuid, p_worker_id text, p_status text, p_error text DEFAULT NULL, p_next_run_at timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  IF p_status NOT IN ('succeeded','superseded','retry_wait','dead_letter') THEN RAISE EXCEPTION 'invalid status %', p_status; END IF;
  UPDATE public.channel_sync_outbox
     SET status = p_status,
         last_error = CASE WHEN p_status = 'succeeded' THEN NULL ELSE left(p_error, 500) END,
         completed_at = CASE WHEN p_status IN ('succeeded','superseded','dead_letter') THEN now() ELSE NULL END,
         next_run_at = COALESCE(p_next_run_at, next_run_at),
         lease_expires_at = NULL, updated_at = now()
   WHERE id = p_id AND worker_id = p_worker_id AND status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $$;

REVOKE ALL ON FUNCTION public.claim_channel_sync_tasks_v2(text, integer, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_channel_sync_tasks_v2(text, integer, integer, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.finish_channel_sync_task(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_channel_sync_task(uuid, text, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.claim_channel_sync_tasks(text, integer, integer) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.claim_channel_sync_tasks(text, integer, integer) IS 'DEPRECATED: replaced by claim_channel_sync_tasks_v2 (expired-lease reclaim + canary filters)';