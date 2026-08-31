-- Handheld fast listing: persist raw images immediately and optimize them asynchronously.
ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS ip_id uuid REFERENCES public.inv_brands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ip_candidate_text text,
  ADD COLUMN IF NOT EXISTS image_processing_status text NOT NULL DEFAULT 'idle'
    CHECK (image_processing_status IN ('idle', 'queued', 'processing', 'succeeded', 'partial_failed', 'retryable_failed')),
  ADD COLUMN IF NOT EXISTS image_processing_updated_at timestamptz;

ALTER TABLE public.inv_sku_classifications
  ADD COLUMN IF NOT EXISTS ip_id uuid REFERENCES public.inv_brands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ip_candidate_text text;

CREATE INDEX IF NOT EXISTS idx_inv_skus_ip ON public.inv_skus(ip_id);

CREATE TABLE IF NOT EXISTS public.inv_listing_image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  source_bucket text NOT NULL CHECK (source_bucket IN ('sku-raw', 'sku-listing')),
  source_path text NOT NULL,
  source_index integer NOT NULL DEFAULT 0 CHECK (source_index >= 0),
  target_bucket text NOT NULL DEFAULT 'sku-listing' CHECK (target_bucket = 'sku-listing'),
  target_path text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'retryable_failed', 'permanent_failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (sku_id, source_bucket, source_path)
);

CREATE INDEX IF NOT EXISTS idx_inv_listing_image_jobs_pending
  ON public.inv_listing_image_jobs(status, next_run_at, created_at);
CREATE INDEX IF NOT EXISTS idx_inv_listing_image_jobs_sku
  ON public.inv_listing_image_jobs(sku_id, source_index);

ALTER TABLE public.inv_listing_image_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_listing_image_jobs FROM anon, authenticated;
GRANT ALL ON public.inv_listing_image_jobs TO service_role;

