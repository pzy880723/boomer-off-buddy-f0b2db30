-- 0059：拍照上架修图 ≤5 分钟 SLA 调度（非破坏性，仅 CREATE OR REPLACE 四个函数，签名不变）。
-- 回滚：重放私有备份 /mnt/documents/.lovable/backups/pre-0059-listing-image-functions-20261013.sql（sha256 f702dc39…cb30）。
-- lease 4min；重试 10/30/60/60s、上限5次；'permanent:'/'ai_consent_missing' 立即失败；SKU组→主图序认领；
-- 超5分钟且已试≥2次 → permanent_failed 'sla_exceeded_5min'；详情图 finish 以 clock_timestamp() 判 lease（含 NULL）；图库优先于详情。
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
      WHEN v_job.attempts>=5 THEN 'worker_lease_expired_or_attempt_limit'
      WHEN v_job.attempts>=2 AND v_job.created_at<now()-interval '5 minutes' THEN 'sla_exceeded_5min' ELSE NULL END;
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

CREATE OR REPLACE FUNCTION public.handheld_listing_image_finish(p_id uuid, p_claim_token uuid, p_target_path text, p_error text DEFAULT NULL::text)
 RETURNS text LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE v_job public.inv_listing_image_jobs; v_sku public.inv_skus; v_status text; v_error text; v_prefix text;
BEGIN
  SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=p_id;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_job.sku_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_job FROM public.inv_listing_image_jobs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'processing' OR p_claim_token IS NULL
    OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until IS NULL
    OR v_job.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  v_error := CASE
    WHEN v_sku.status IS DISTINCT FROM 'active' THEN 'sku_not_active'
    WHEN NOT coalesce((v_job.source_bucket||'/'||v_job.source_path)=ANY(v_sku.image_paths),false)
      THEN 'source_removed_not_applied' ELSE NULL END;
  IF v_error IS NOT NULL THEN v_status := 'permanent_failed';
  ELSIF p_error IS NOT NULL THEN
    v_error := left(p_error,1000);
    v_status := CASE WHEN v_job.attempts>=5 OR p_error LIKE 'permanent:%' OR p_error LIKE 'ai_consent_missing%'
      THEN 'permanent_failed' ELSE 'retryable_failed' END;
  ELSE
    v_prefix := 'sku-listing/gallery/'||v_job.sku_id::text||'/'||v_job.id::text||'/'||p_claim_token::text;
    IF p_target_path IS NULL OR p_target_path NOT IN (v_prefix||'.png',v_prefix||'.jpg',v_prefix||'.webp')
      OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='sku-listing'
        AND name=substring(p_target_path FROM length('sku-listing/')+1)) THEN
      RAISE EXCEPTION 'invalid_listing_image_target';
    END IF;
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
      CASE v_job.attempts WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END)
      ELSE next_run_at END
    WHERE id=p_id;
  PERFORM public.handheld_listing_image_refresh_status(v_job.sku_id);
  RETURN v_status;
END;
$function$;

CREATE OR REPLACE FUNCTION public.product_content_image_claim(p_limit integer)
 RETURNS SETOF public.inv_product_content_image_jobs LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN
  UPDATE public.inv_product_content_image_jobs SET status='permanent_failed',lease_until=NULL,
    last_error='worker lease expired after final attempt',updated_at=now()
   WHERE status='processing' AND lease_until<now() AND attempts>=5;
  UPDATE public.inv_product_content_image_jobs j SET status='cancelled',updated_at=now()
   WHERE (j.status IN ('queued','retryable_failed') OR (j.status='processing' AND j.lease_until<now()))
     AND NOT EXISTS (
       SELECT 1 FROM public.inv_product_content c JOIN public.inv_skus s ON s.id=c.sku_id,
         LATERAL jsonb_array_elements(c.published_blocks) b
        WHERE c.sku_id=j.sku_id AND s.status='active' AND s.kind='single' AND s.is_custom_price
          AND b->>'type'='image' AND b->>'id'=j.block_id AND b->>'storage_path'=j.source_path);
  IF EXISTS (SELECT 1 FROM public.inv_listing_image_jobs g
      WHERE (g.status IN ('queued','retryable_failed') AND g.next_run_at<=now())
         OR (g.status='processing' AND coalesce(g.lease_until,'-infinity'::timestamptz)<=now())) THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.inv_product_content_image_jobs
     WHERE attempts<5 AND ((status IN ('queued','retryable_failed') AND next_run_at<=now())
        OR (status='processing' AND lease_until<now()))
     ORDER BY created_at,id LIMIT greatest(1,least(coalesce(p_limit,2),6)) FOR UPDATE SKIP LOCKED
  )
  UPDATE public.inv_product_content_image_jobs j SET status='processing',attempts=j.attempts+1,
    claim_token=gen_random_uuid(),lease_until=now()+interval '4 minutes',updated_at=now()
    FROM due WHERE j.id=due.id RETURNING j.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.product_content_image_finish(p_id uuid, p_claim_token uuid, p_target_path text, p_error text)
 RETURNS text LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE
  v_job public.inv_product_content_image_jobs; v_sku public.inv_skus; v_content public.inv_product_content;
  v_draft jsonb; v_published jsonb; v_status text; v_prefix text;
BEGIN
  SELECT * INTO v_job FROM public.inv_product_content_image_jobs WHERE id=p_id;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_job.sku_id FOR UPDATE;
  SELECT * INTO v_job FROM public.inv_product_content_image_jobs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'processing' OR p_claim_token IS NULL
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until IS NULL
     OR v_job.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  SELECT * INTO v_content FROM public.inv_product_content WHERE sku_id=v_job.sku_id FOR UPDATE;
  IF NOT FOUND OR v_sku.status IS DISTINCT FROM 'active' OR v_sku.kind IS DISTINCT FROM 'single'
     OR NOT coalesce(v_sku.is_custom_price,false) THEN
    v_status := 'cancelled';
  ELSIF p_error IS NOT NULL THEN
    v_status := CASE WHEN v_job.attempts>=5 OR p_error LIKE 'permanent:%' OR p_error LIKE 'ai_consent_missing%'
      THEN 'permanent_failed' ELSE 'retryable_failed' END;
  ELSE
    v_prefix := 'sku-listing/content/'||v_job.sku_id::text||'/'||v_job.id::text||'/'||p_claim_token::text;
    IF p_target_path IS NULL OR p_target_path NOT IN (v_prefix||'.png',v_prefix||'.jpg',v_prefix||'.webp')
       OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='sku-listing'
                       AND name=substring(p_target_path FROM length('sku-listing/')+1)) THEN
      PERFORM public.handheld_item_fail('validation_error','Invalid optimized content image');
    END IF;
    SELECT coalesce(jsonb_agg(CASE WHEN b->>'type'='image' AND b->>'id'=v_job.block_id
      AND b->>'storage_path'=v_job.source_path THEN jsonb_set(b,'{storage_path}',to_jsonb(p_target_path)) ELSE b END ORDER BY ord),'[]')
      INTO v_draft FROM jsonb_array_elements(v_content.draft_blocks) WITH ORDINALITY blocks(b,ord);
    SELECT coalesce(jsonb_agg(CASE WHEN b->>'type'='image' AND b->>'id'=v_job.block_id
      AND b->>'storage_path'=v_job.source_path THEN jsonb_set(b,'{storage_path}',to_jsonb(p_target_path)) ELSE b END ORDER BY ord),'[]')
      INTO v_published FROM jsonb_array_elements(v_content.published_blocks) WITH ORDINALITY blocks(b,ord);
    IF v_draft IS DISTINCT FROM v_content.draft_blocks OR v_published IS DISTINCT FROM v_content.published_blocks THEN
      UPDATE public.inv_product_content SET draft_blocks=v_draft,published_blocks=v_published,
        version=version+1,published_version=CASE WHEN v_published IS DISTINCT FROM v_content.published_blocks
          THEN version+1 ELSE published_version END,updated_at=now() WHERE sku_id=v_job.sku_id;
      v_status := 'succeeded';
    ELSE v_status := 'cancelled'; END IF;
  END IF;
  UPDATE public.inv_product_content_image_jobs SET status=v_status,lease_until=NULL,
    target_path=CASE WHEN p_error IS NULL THEN p_target_path ELSE target_path END,
    last_error=left(p_error,1000),updated_at=now(),
    next_run_at=now()+make_interval(secs=>CASE v_job.attempts WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 60 END)
   WHERE id=p_id;
  RETURN v_status;
END;
$function$;