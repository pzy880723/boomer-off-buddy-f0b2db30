
ALTER TABLE public.stocktake_scans
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.inv_handheld_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scanned_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS stocktake_scans_st_device_idx
  ON public.stocktake_scans(stocktake_id, device_id);
