-- 终止态：五次已停止的任务不再让 SKU 显示 retryable_failed（避免客户端无限“正在自动重试”轮询）。
-- 非破坏：保留全部旧状态值，仅新增 failed / partial_failed_terminal。
ALTER TABLE public.inv_skus ADD CONSTRAINT inv_skus_image_processing_status_check_v2 CHECK ((image_processing_status = ANY (ARRAY['idle'::text, 'queued'::text, 'processing'::text, 'succeeded'::text, 'partial_failed'::text, 'retryable_failed'::text, 'failed'::text, 'partial_failed_terminal'::text])));
ALTER TABLE public.inv_skus DROP CONSTRAINT inv_skus_image_processing_status_check;
ALTER TABLE public.inv_skus RENAME CONSTRAINT inv_skus_image_processing_status_check_v2 TO inv_skus_image_processing_status_check;

CREATE OR REPLACE FUNCTION public.handheld_listing_image_refresh_status(p_sku_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_paths text[];
BEGIN
  -- 锁顺序不变：先 SKU 行，再读任务
  SELECT coalesce(image_paths, '{}'::text[]) INTO v_paths FROM public.inv_skus WHERE id=p_sku_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.inv_skus SET image_processing_status=(
    SELECT CASE
      WHEN count(*)=0 THEN 'idle'
      WHEN bool_or(j.status='processing') THEN 'processing'
      WHEN bool_or(j.status='queued') THEN 'queued'
      WHEN bool_or(j.status='retryable_failed') THEN 'retryable_failed'
      WHEN bool_and(j.status='succeeded') THEN 'succeeded'
      WHEN bool_or(j.status='succeeded') THEN 'partial_failed_terminal'
      ELSE 'failed' END
    FROM public.inv_listing_image_jobs j
    WHERE j.sku_id=p_sku_id
      AND ((j.source_bucket||'/'||j.source_path) = ANY(v_paths)
        OR (j.status='succeeded' AND j.target_path IS NOT NULL
            AND (j.target_bucket||'/'||j.target_path) = ANY(v_paths)))
  ),image_processing_updated_at=now() WHERE id=p_sku_id;
END;
$function$;