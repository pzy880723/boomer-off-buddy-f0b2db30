CREATE TABLE IF NOT EXISTS public.youzan_category_group_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.inv_categories(id) ON DELETE CASCADE,
  hq_shop_id uuid NOT NULL REFERENCES public.youzan_shops(id) ON DELETE CASCADE,
  channel smallint NOT NULL CHECK (channel IN (0, 1)),
  youzan_group_id bigint NOT NULL CHECK (youzan_group_id > 0),
  parent_youzan_group_id bigint,
  group_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'error')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, hq_shop_id, channel),
  UNIQUE (hq_shop_id, channel, youzan_group_id)
);

CREATE INDEX IF NOT EXISTS idx_youzan_category_group_links_shop_channel
  ON public.youzan_category_group_links (hq_shop_id, channel, status);

COMMENT ON TABLE public.youzan_category_group_links IS
  'ERP inv_categories to Youzan product-group mapping. These IDs are product group IDs, never retail category_id values.';
COMMENT ON COLUMN public.youzan_category_group_links.channel IS
  'Youzan product-group channel: 0 web shop, 1 physical store.';

CREATE TABLE IF NOT EXISTS public.youzan_category_group_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  dry_run boolean NOT NULL DEFAULT true,
  hq_shop_id uuid REFERENCES public.youzan_shops(id) ON DELETE SET NULL,
  hq_kdt_id bigint,
  channels smallint[] NOT NULL DEFAULT ARRAY[0, 1]::smallint[],
  category_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_youzan_category_group_sync_runs_started_at
  ON public.youzan_category_group_sync_runs (started_at DESC);

COMMENT ON TABLE public.youzan_category_group_sync_runs IS
  'Audit and rollback evidence for ERP taxonomy to Youzan product-group synchronization.';

ALTER TABLE public.youzan_category_group_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youzan_category_group_sync_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.youzan_category_group_links FROM anon, authenticated;
REVOKE ALL ON public.youzan_category_group_sync_runs FROM anon, authenticated;
