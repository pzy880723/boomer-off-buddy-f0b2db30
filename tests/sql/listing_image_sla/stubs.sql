CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects(bucket_id text, name text);
CREATE TABLE public.inv_skus(id uuid PRIMARY KEY, status text DEFAULT 'active', kind text DEFAULT 'single', is_custom_price boolean DEFAULT true,
  image_paths text[], image_url text, updated_at timestamptz, image_processing_status text, image_processing_updated_at timestamptz, refresh_count int DEFAULT 0);
CREATE TABLE public.commerce_listings(sku_id uuid, status text, image_paths jsonb, updated_at timestamptz);
CREATE TABLE public.inv_listing_image_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, source_bucket text, source_path text, source_index int DEFAULT 0,
  target_bucket text DEFAULT 'sku-listing', target_path text, status text DEFAULT 'queued', attempts int DEFAULT 0, next_run_at timestamptz DEFAULT now(),
  locked_at timestamptz, locked_by text, last_error text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), completed_at timestamptz,
  claim_token uuid, lease_until timestamptz, ai_actor_user_id uuid, ai_policy_version text, UNIQUE(sku_id,source_bucket,source_path));
CREATE TABLE public.inv_product_content(sku_id uuid PRIMARY KEY, draft_blocks jsonb, published_blocks jsonb, version int DEFAULT 1, published_version int, updated_at timestamptz);
CREATE TABLE public.inv_product_content_image_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, block_id text, source_path text, target_path text,
  status text DEFAULT 'queued', attempts int DEFAULT 0, claim_token uuid, lease_until timestamptz, next_run_at timestamptz DEFAULT now(), last_error text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), ai_actor_user_id uuid, ai_policy_version text);
CREATE FUNCTION public.handheld_item_fail(text,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '%',$1; END$$;
-- 线上 refresh_status / apply_result 原样（apply 外加刷新计数以证明触发同步）
CREATE FUNCTION public.handheld_listing_image_refresh_status(p_sku_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.inv_skus SET image_processing_status=(SELECT CASE WHEN count(*)=0 THEN 'idle' WHEN bool_and(status='succeeded') THEN 'succeeded'
    WHEN bool_or(status='processing') THEN 'processing' WHEN bool_or(status='queued') THEN 'queued' WHEN bool_or(status='succeeded') THEN 'partial_failed'
    ELSE 'retryable_failed' END FROM public.inv_listing_image_jobs WHERE sku_id=p_sku_id), image_processing_updated_at=now() WHERE id=p_sku_id;
END $$;
CREATE FUNCTION public.handheld_apply_listing_image_result(p_sku_id uuid, p_source_key text, p_target_key text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_paths text[];
BEGIN
  SELECT image_paths INTO v_paths FROM public.inv_skus WHERE id=p_sku_id FOR UPDATE;
  IF NOT coalesce(p_source_key=ANY(v_paths),false) THEN RETURN false; END IF;
  UPDATE public.inv_skus SET image_paths=array_replace(v_paths,p_source_key,p_target_key), refresh_count=refresh_count+1 WHERE id=p_sku_id;
  RETURN true;
END $$;
