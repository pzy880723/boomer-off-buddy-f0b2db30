-- 0060：移除 0059 claim 中“超5分钟且 attempts>=2 即 permanent_failed”的误杀规则（非破坏性函数替换，签名不变）。
-- 保留：max 5 次、source 移除/SKU 非 active 终止、claim_token、4min lease、组/主图优先。SLA 超时改为只读告警函数，不改状态。
-- 回滚：重放私有备份 .lovable/backups/pre-0060-listing-image-claim-20261013.sql。
CREATE OR REPLACE FUNCTION public.handheld_listing_image_claim(p_limit integer DEFAULT 2)
 RETURNS SETOF public.inv_listing_image_jobs LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE v_candidate record; v_job public.inv_listing_image_jobs; v_sku public.inv_skus; v_error text;
BEGIN
  FOR v_candidate IN
    SELECT j.id, j.sku_id FROM (
      SELECT j.*, min(j.created_at) OVER (PARTITION BY j.sku_id) AS grp_at
        FROM public.inv_listing_image_jobs j
       WHERE (j.status IN ('queued','retryable_failed') AND j.next_run_at<=now())
          OR (j.status='processing' AND coalesce(j.lease_until,j.locked_at+interval '4 minutes','-infinity'::timestamptz)<=now())
    ) j
    ORDER BY j.grp_at, j.sku_id, j.source_index, j.id
    LIMIT greatest(1,least(coalesce(p_limit,2),6))
  LOOP
    SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_candidate.sku_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=v_candidate.id
      AND ((status IN ('queued','retryable_failed') AND next_run_at<=now())
        OR (status='processing' AND coalesce(lease_until,locked_at+interval '4 minutes','-infinity'::timestamptz)<=now()))
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    v_error := CASE
      WHEN v_sku.status IS DISTINCT FROM 'active' THEN 'sku_not_active'
      WHEN NOT coalesce((v_job.source_bucket||'/'||v_job.source_path)=ANY(v_sku.image_paths),false)
        THEN 'source_removed_not_applied'
      WHEN v_job.attempts>=5 THEN 'worker_lease_expired_or_attempt_limit' ELSE NULL END;
    IF v_error IS NOT NULL THEN
      UPDATE public.inv_listing_image_jobs SET status='permanent_failed',last_error=v_error,
        claim_token=NULL,lease_until=NULL,locked_at=NULL,locked_by=NULL,updated_at=now()
        WHERE id=v_job.id;
    ELSE
      UPDATE public.inv_listing_image_jobs SET status='processing',attempts=attempts+1,
        claim_token=gen_random_uuid(),lease_until=now()+interval '4 minutes',
        locked_at=now(),locked_by=NULL,updated_at=now()
        WHERE id=v_job.id RETURNING * INTO v_job;
    END IF;
    PERFORM public.handheld_listing_image_refresh_status(v_job.sku_id);
    IF v_error IS NULL THEN RETURN NEXT v_job; END IF;
  END LOOP;
END;
$function$;

-- 5 分钟 SLA 只读告警：未成功且已超 5 分钟的图库任务（不改任何状态）。
CREATE OR REPLACE FUNCTION public.handheld_listing_image_sla_overdue(p_minutes integer DEFAULT 5)
 RETURNS TABLE(job_id uuid, sku_id uuid, status text, attempts integer, age_seconds integer, last_error text)
 LANGUAGE sql STABLE SET search_path TO '' AS $function$
  SELECT j.id, j.sku_id, j.status, j.attempts, extract(epoch FROM now()-j.created_at)::integer, left(j.last_error,200)
    FROM public.inv_listing_image_jobs j
   WHERE j.status IN ('queued','processing','retryable_failed')
     AND j.created_at < now()-make_interval(mins=>greatest(1,coalesce(p_minutes,5)))
   ORDER BY j.created_at
$function$;
REVOKE ALL ON FUNCTION public.handheld_listing_image_sla_overdue(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_listing_image_sla_overdue(integer) TO service_role;