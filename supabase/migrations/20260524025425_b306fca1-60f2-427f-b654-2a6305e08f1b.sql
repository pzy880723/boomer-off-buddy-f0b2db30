ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS sku_code text,
  ADD COLUMN IF NOT EXISTS bundle_items jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_inv_skus_sku_code ON public.inv_skus(sku_code) WHERE sku_code IS NOT NULL;