ALTER TABLE public.youzan_shops
  ADD COLUMN IF NOT EXISTS sell_channel_id bigint,
  ADD COLUMN IF NOT EXISTS warehouse_code text,
  ADD COLUMN IF NOT EXISTS warehouse_name text,
  ADD COLUMN IF NOT EXISTS chain_probe_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS chain_probe_result jsonb,
  ADD COLUMN IF NOT EXISTS chain_probe_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_youzan_shops_chain_probe_status ON public.youzan_shops(chain_probe_status);
CREATE INDEX IF NOT EXISTS idx_youzan_shops_sell_channel_id ON public.youzan_shops(sell_channel_id);

ALTER TABLE public.youzan_shops
  DROP CONSTRAINT IF EXISTS youzan_shops_chain_probe_status_check;
ALTER TABLE public.youzan_shops
  ADD CONSTRAINT youzan_shops_chain_probe_status_check
  CHECK (chain_probe_status IN ('unknown', 'ok', 'partial', 'failed'));
