ALTER TABLE public.inv_label_batches ADD COLUMN IF NOT EXISTS parcel_item_id uuid;
CREATE INDEX IF NOT EXISTS idx_inv_label_batches_parcel_item_id ON public.inv_label_batches(parcel_item_id);