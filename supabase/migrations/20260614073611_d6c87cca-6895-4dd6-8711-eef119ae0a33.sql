
-- 1) 绑定关系表
CREATE TABLE public.sku_youzan_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.youzan_shops(id) ON DELETE CASCADE,
  yz_item_id bigint NOT NULL,
  yz_sku_id bigint,
  last_pushed_stock integer,
  last_pushed_at timestamptz,
  last_pull_stock integer,
  last_pull_at timestamptz,
  status text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','mismatch','error')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sku_youzan_links_sku_id_key UNIQUE (sku_id),
  CONSTRAINT sku_youzan_links_yz_key UNIQUE (shop_id, yz_item_id, yz_sku_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sku_youzan_links TO authenticated;
GRANT ALL ON public.sku_youzan_links TO service_role;

ALTER TABLE public.sku_youzan_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_select_sku_youzan_links" ON public.sku_youzan_links FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_sku_youzan_links" ON public.sku_youzan_links FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_sku_youzan_links" ON public.sku_youzan_links FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete_sku_youzan_links" ON public.sku_youzan_links FOR DELETE TO authenticated USING (true);

CREATE TRIGGER trg_sku_youzan_links_updated BEFORE UPDATE ON public.sku_youzan_links FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE INDEX idx_sku_youzan_links_status ON public.sku_youzan_links(status);
CREATE INDEX idx_sku_youzan_links_yz_item ON public.sku_youzan_links(yz_item_id);

-- 2) 库存推送队列表
CREATE TABLE public.youzan_stock_sync_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  target_stock integer NOT NULL,
  reason text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.youzan_stock_sync_queue TO authenticated;
GRANT ALL ON public.youzan_stock_sync_queue TO service_role;

ALTER TABLE public.youzan_stock_sync_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_select_yz_stock_queue" ON public.youzan_stock_sync_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_yz_stock_queue" ON public.youzan_stock_sync_queue FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_yz_stock_queue" ON public.youzan_stock_sync_queue FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete_yz_stock_queue" ON public.youzan_stock_sync_queue FOR DELETE TO authenticated USING (true);

CREATE TRIGGER trg_youzan_stock_sync_queue_updated BEFORE UPDATE ON public.youzan_stock_sync_queue FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE INDEX idx_youzan_stock_queue_pending ON public.youzan_stock_sync_queue(status, next_run_at);
CREATE INDEX idx_youzan_stock_queue_sku ON public.youzan_stock_sync_queue(sku_id);
