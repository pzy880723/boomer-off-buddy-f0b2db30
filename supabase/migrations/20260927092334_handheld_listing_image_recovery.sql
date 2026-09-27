-- Legacy gallery recovery. Keep existing status CHECK values and source-key CAS semantics.
ALTER TABLE public.inv_listing_image_jobs
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_until timestamptz;
CREATE INDEX inv_listing_image_jobs_expired ON public.inv_listing_image_jobs(lease_until,locked_at)
  WHERE status='processing';

CREATE FUNCTION public.handheld_listing_image_refresh_status(p_sku_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.inv_skus WHERE id=p_sku_id FOR UPDATE;
  UPDATE public.inv_skus SET image_processing_status=(
    SELECT CASE
      WHEN count(*)=0 THEN 'idle'
      WHEN bool_and(status='succeeded') THEN 'succeeded'
      WHEN bool_or(status='processing') THEN 'processing'
      WHEN bool_or(status='queued') THEN 'queued'
      WHEN bool_or(status='succeeded') THEN 'partial_failed'
      ELSE 'retryable_failed' END
    FROM public.inv_listing_image_jobs WHERE sku_id=p_sku_id
  ),image_processing_updated_at=now() WHERE id=p_sku_id;
END;
$$;

CREATE FUNCTION public.handheld_listing_image_claim(p_limit integer DEFAULT 2)
RETURNS SETOF public.inv_listing_image_jobs
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_candidate record; v_job public.inv_listing_image_jobs; v_sku public.inv_skus; v_error text;
BEGIN
  FOR v_candidate IN
    SELECT id,sku_id FROM public.inv_listing_image_jobs
    WHERE (status IN ('queued','retryable_failed') AND next_run_at<=now())
      OR (status='processing' AND coalesce(lease_until,locked_at+interval '5 minutes','-infinity'::timestamptz)<=now())
    ORDER BY created_at,id LIMIT greatest(1,least(coalesce(p_limit,2),6))
  LOOP
    -- Match finish/manual-edit lock order: SKU before job. Never steal a live claim.
    SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_candidate.sku_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=v_candidate.id
      AND ((status IN ('queued','retryable_failed') AND next_run_at<=now())
        OR (status='processing' AND coalesce(lease_until,locked_at+interval '5 minutes','-infinity'::timestamptz)<=now()))
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    v_error := CASE
      WHEN v_sku.status IS DISTINCT FROM 'active' THEN 'sku_not_active'
      WHEN NOT coalesce((v_job.source_bucket||'/'||v_job.source_path)=ANY(v_sku.image_paths),false)
        THEN 'source_removed_not_applied'
      WHEN v_job.attempts>=5 THEN 'worker_lease_expired_or_attempt_limit' ELSE NULL END;
    IF v_error IS NOT NULL THEN
      UPDATE public.inv_listing_image_jobs SET status='permanent_failed',last_error=v_error,
        claim_token=NULL,lease_until=NULL,locked_by=NULL,locked_at=NULL,updated_at=now()
        WHERE id=v_job.id;
    ELSE
      UPDATE public.inv_listing_image_jobs SET status='processing',attempts=attempts+1,
        claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',
        locked_at=now(),locked_by=NULL,updated_at=now()
        WHERE id=v_job.id RETURNING * INTO v_job;
    END IF;
    PERFORM public.handheld_listing_image_refresh_status(v_job.sku_id);
    IF v_error IS NULL THEN RETURN NEXT v_job; END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.handheld_listing_image_finish(
  p_id uuid,p_claim_token uuid,p_target_path text,p_error text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_job public.inv_listing_image_jobs; v_sku public.inv_skus; v_status text; v_error text; v_prefix text;
BEGIN
  SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=p_id;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_job.sku_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'processing' OR p_claim_token IS NULL
    OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until IS NULL
    -- A request may have waited on the SKU lock past its lease after transaction start.
    OR v_job.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;

  v_error := CASE
    WHEN v_sku.status IS DISTINCT FROM 'active' THEN 'sku_not_active'
    WHEN NOT coalesce((v_job.source_bucket||'/'||v_job.source_path)=ANY(v_sku.image_paths),false)
      THEN 'source_removed_not_applied' ELSE NULL END;
  IF v_error IS NOT NULL THEN v_status := 'permanent_failed';
  ELSIF p_error IS NOT NULL THEN
    v_error := left(p_error,1000);
    v_status := CASE WHEN v_job.attempts>=5 THEN 'permanent_failed' ELSE 'retryable_failed' END;
  ELSE
    v_prefix := 'sku-listing/gallery/'||v_job.sku_id::text||'/'||v_job.id::text||'/'||p_claim_token::text;
    IF p_target_path IS NULL OR p_target_path NOT IN (v_prefix||'.png',v_prefix||'.jpg',v_prefix||'.webp')
      OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='sku-listing'
        AND name=substring(p_target_path FROM length('sku-listing/')+1)) THEN
      RAISE EXCEPTION 'invalid_listing_image_target';
    END IF;
    -- Ownership is checked BEFORE applying. Images, outbox triggers, job and SKU status commit together.
    IF public.handheld_apply_listing_image_result(v_job.sku_id,
      v_job.source_bucket||'/'||v_job.source_path,p_target_path) THEN
      v_status := 'succeeded';
    ELSE
      v_status := 'permanent_failed'; v_error := 'source_removed_not_applied';
    END IF;
  END IF;
  UPDATE public.inv_listing_image_jobs SET status=v_status,
    target_path=CASE WHEN v_status='succeeded' THEN substring(p_target_path FROM length('sku-listing/')+1) ELSE target_path END,
    last_error=v_error,lease_until=NULL,locked_at=NULL,locked_by=NULL,updated_at=now(),
    completed_at=CASE WHEN v_status='succeeded' THEN now() ELSE completed_at END,
    next_run_at=CASE WHEN v_status='retryable_failed' THEN now()+make_interval(secs=>
      CASE v_job.attempts WHEN 1 THEN 30 WHEN 2 THEN 300 WHEN 3 THEN 1800 ELSE 7200 END)
      ELSE next_run_at END
    WHERE id=p_id;
  PERFORM public.handheld_listing_image_refresh_status(v_job.sku_id);
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.handheld_listing_image_refresh_status(uuid),
  public.handheld_listing_image_claim(integer),public.handheld_listing_image_finish(uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_listing_image_refresh_status(uuid),
  public.handheld_listing_image_claim(integer),public.handheld_listing_image_finish(uuid,uuid,text,text)
  TO service_role;
NOTIFY pgrst,'reload schema';
