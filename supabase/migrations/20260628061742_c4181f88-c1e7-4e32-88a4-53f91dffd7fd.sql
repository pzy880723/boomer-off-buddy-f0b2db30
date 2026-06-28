
-- 1. inv_handheld_devices: capabilities / version
ALTER TABLE public.inv_handheld_devices
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS app_version text,
  ADD COLUMN IF NOT EXISTS os_version text;

-- 2. inv_handheld_op_log
CREATE TABLE IF NOT EXISTS public.inv_handheld_op_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.inv_handheld_devices(id) ON DELETE CASCADE,
  client_op_id text NOT NULL,
  op_type text NOT NULL,
  request_hash text,
  response_status int NOT NULL DEFAULT 200,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inv_handheld_op_log_dev_client_uk
  ON public.inv_handheld_op_log(device_id, client_op_id);
CREATE INDEX IF NOT EXISTS inv_handheld_op_log_created_idx
  ON public.inv_handheld_op_log(created_at DESC);

GRANT ALL ON public.inv_handheld_op_log TO service_role;

ALTER TABLE public.inv_handheld_op_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "op_log_deny_all" ON public.inv_handheld_op_log FOR ALL USING (false) WITH CHECK (false);

-- 3. inv_handheld_notifications
CREATE TABLE IF NOT EXISTS public.inv_handheld_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid REFERENCES public.inv_handheld_devices(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('stocktake_assigned','transfer_incoming','youzan_sync_failed','unclaimed_epc_pending','system')),
  title text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ts timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_handheld_notif_device_ts_idx
  ON public.inv_handheld_notifications(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS inv_handheld_notif_location_ts_idx
  ON public.inv_handheld_notifications(location_id, ts DESC);
CREATE INDEX IF NOT EXISTS inv_handheld_notif_ts_idx
  ON public.inv_handheld_notifications(ts DESC);

GRANT ALL ON public.inv_handheld_notifications TO service_role;

ALTER TABLE public.inv_handheld_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_deny_all" ON public.inv_handheld_notifications FOR ALL USING (false) WITH CHECK (false);

-- 4. inv_handheld_diag
CREATE TABLE IF NOT EXISTS public.inv_handheld_diag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid REFERENCES public.inv_handheld_devices(id) ON DELETE SET NULL,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('crash','network','api_error','device')),
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  app_version text,
  os_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inv_handheld_diag_device_created_idx
  ON public.inv_handheld_diag(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inv_handheld_diag_kind_created_idx
  ON public.inv_handheld_diag(kind, created_at DESC);

GRANT ALL ON public.inv_handheld_diag TO service_role;

ALTER TABLE public.inv_handheld_diag ENABLE ROW LEVEL SECURITY;
CREATE POLICY "diag_deny_all" ON public.inv_handheld_diag FOR ALL USING (false) WITH CHECK (false);
