-- 0076 依赖夹具：列定义与真实库 information_schema / pg_indexes 只读结果一致；
-- handheld_apply_listing_image_result 为真实函数体原样拷贝；refresh_status 仅保留锁序（不影响门禁）。
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.objects (bucket_id text, name text);
CREATE UNIQUE INDEX inv_listing_image_jobs_sku_id_source_bucket_source_path_key
  ON public.inv_listing_image_jobs (sku_id, source_bucket, source_path);
CREATE TABLE public.inv_product_content_image_jobs (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, sku_id uuid NOT NULL,
  block_id text NOT NULL, source_path text NOT NULL CHECK (source_path LIKE 'sku-raw/%'), target_path text,
  status text DEFAULT 'queued' NOT NULL CHECK (status IN ('queued','processing','retryable_failed','permanent_failed','succeeded','cancelled')),
  attempts integer DEFAULT 0 NOT NULL, claim_token uuid, lease_until timestamptz, next_run_at timestamptz DEFAULT now() NOT NULL,
  last_error text, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  ai_actor_user_id uuid, ai_policy_version text);
CREATE TABLE public.inv_sku_facets (sku_id uuid NOT NULL, facet_id uuid NOT NULL, PRIMARY KEY (sku_id, facet_id));
CREATE FUNCTION public.handheld_listing_image_refresh_status(p_sku_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN PERFORM 1 FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE; END $$;
CREATE FUNCTION public.handheld_apply_listing_image_result(p_sku_id uuid, p_source_key text, p_target_key text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_paths text[]; v_next text[];
BEGIN
  IF p_source_key IS NULL OR p_target_key IS NULL OR p_target_key NOT LIKE 'sku-listing/%' THEN
    RAISE EXCEPTION 'invalid_image_result';
  END IF;
  SELECT image_paths INTO v_paths FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(p_source_key = ANY(v_paths), false) THEN RETURN false; END IF;
  SELECT array_agg(path ORDER BY first_ord) INTO v_next FROM (
    SELECT CASE WHEN value = p_source_key THEN p_target_key ELSE value END AS path, min(ord) AS first_ord
      FROM unnest(v_paths) WITH ORDINALITY t(value, ord) GROUP BY 1) deduped;
  UPDATE public.inv_skus SET image_paths = v_next,
    image_url = CASE WHEN v_next[1] LIKE 'https://%' THEN v_next[1] ELSE NULL END, updated_at = now() WHERE id = p_sku_id;
  RETURN true;
END $$;
