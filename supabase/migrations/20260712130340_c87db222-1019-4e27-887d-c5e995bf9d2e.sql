
CREATE TABLE IF NOT EXISTS public.integration_api_registry (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  capability_name TEXT NOT NULL,
  requirement TEXT NOT NULL,
  method TEXT NOT NULL,
  version TEXT NOT NULL,
  scope TEXT NOT NULL,
  token_scope TEXT NOT NULL DEFAULT 'both',
  http_verb TEXT NOT NULL DEFAULT 'POST',
  doc_url TEXT,
  note TEXT,
  is_overridden BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  UNIQUE (platform, capability_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_api_registry TO authenticated;
GRANT ALL ON public.integration_api_registry TO service_role;

ALTER TABLE public.integration_api_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin read integration_api_registry"
  ON public.integration_api_registry FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "admin write integration_api_registry"
  ON public.integration_api_registry FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE TRIGGER trg_integration_api_registry_updated
  BEFORE UPDATE ON public.integration_api_registry
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE IF NOT EXISTS public.integration_api_probes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  shop_id UUID,
  method TEXT NOT NULL,
  version TEXT NOT NULL,
  request_params JSONB,
  http_status INTEGER,
  gw_code INTEGER,
  trace_id TEXT,
  latency_ms INTEGER,
  ok BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  response_snippet TEXT,
  tested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tested_by UUID
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_api_probes TO authenticated;
GRANT ALL ON public.integration_api_probes TO service_role;

ALTER TABLE public.integration_api_probes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin read integration_api_probes"
  ON public.integration_api_probes FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));

CREATE POLICY "admin write integration_api_probes"
  ON public.integration_api_probes FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE INDEX IF NOT EXISTS idx_integration_api_probes_cap
  ON public.integration_api_probes (platform, capability_key, tested_at DESC);
