
CREATE TABLE public.youzan_shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kdt_id bigint NOT NULL UNIQUE,
  shop_name text NOT NULL,
  role text NOT NULL DEFAULT 'branch' CHECK (role IN ('hq','branch')),
  parent_kdt_id bigint,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','expired')),
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  authorized_at timestamptz,
  expires_at timestamptz,
  last_ping_at timestamptz,
  last_ping_ok boolean,
  last_ping_msg text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_youzan_shops_role ON public.youzan_shops(role);
CREATE INDEX idx_youzan_shops_parent ON public.youzan_shops(parent_kdt_id);

ALTER TABLE public.youzan_shops ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_youzan_shops ON public.youzan_shops FOR SELECT USING (true);
CREATE POLICY open_insert_youzan_shops ON public.youzan_shops FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_youzan_shops ON public.youzan_shops FOR UPDATE USING (true);
CREATE POLICY open_delete_youzan_shops ON public.youzan_shops FOR DELETE USING (true);

CREATE TRIGGER trg_youzan_shops_updated_at
  BEFORE UPDATE ON public.youzan_shops
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.youzan_sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid REFERENCES public.youzan_shops(id) ON DELETE CASCADE,
  kdt_id bigint,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
  count_in integer NOT NULL DEFAULT 0,
  count_out integer NOT NULL DEFAULT 0,
  message text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX idx_youzan_sync_logs_shop ON public.youzan_sync_logs(shop_id, started_at DESC);
CREATE INDEX idx_youzan_sync_logs_started ON public.youzan_sync_logs(started_at DESC);

ALTER TABLE public.youzan_sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_youzan_sync_logs ON public.youzan_sync_logs FOR SELECT USING (true);
CREATE POLICY open_insert_youzan_sync_logs ON public.youzan_sync_logs FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_youzan_sync_logs ON public.youzan_sync_logs FOR UPDATE USING (true);
CREATE POLICY open_delete_youzan_sync_logs ON public.youzan_sync_logs FOR DELETE USING (true);

INSERT INTO public.youzan_shops (kdt_id, shop_name, role, status, authorized_at, expires_at, notes)
VALUES (153242272, 'BOOMER OFF vintage', 'hq', 'active',
        '2025-11-11 17:51:38+00', '2026-11-11 17:51:38+00',
        '初始授权店铺，待确认是总部还是分店');
