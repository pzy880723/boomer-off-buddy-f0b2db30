CREATE ROLE service_role; 
CREATE TABLE public.inv_skus(id uuid primary key, image_paths text[], image_processing_status text not null default 'idle',
  image_processing_updated_at timestamptz,
  CONSTRAINT inv_skus_image_processing_status_check CHECK (image_processing_status = ANY (ARRAY['idle','queued','processing','succeeded','partial_failed','retryable_failed'])));
CREATE TABLE public.inv_listing_image_jobs(id uuid primary key default gen_random_uuid(), sku_id uuid, source_bucket text, source_path text,
  target_bucket text default 'sku-listing', target_path text, status text);
