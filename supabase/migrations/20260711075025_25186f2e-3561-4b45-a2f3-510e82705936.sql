
ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS sales_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS inventory_version bigint NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE public.inv_skus
    ADD CONSTRAINT inv_skus_sales_state_check
    CHECK (sales_state IN ('draft','publishing','active','sold_syncing','sold','return_pending','return_inspecting','retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_inv_skus_sales_state ON public.inv_skus(sales_state);

CREATE TABLE IF NOT EXISTS public.inventory_sale_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_channel text NOT NULL,
  source_shop_id uuid,
  source_order_id text NOT NULL,
  event_type text NOT NULL,
  event_version bigint NOT NULL DEFAULT 0,
  sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  epc text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received',
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT inventory_sale_events_status_check
    CHECK (status IN ('received','processed','unmatched','oversold','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_sale_events_source
  ON public.inventory_sale_events(source_channel, source_order_id, event_type);
CREATE INDEX IF NOT EXISTS idx_sale_events_status ON public.inventory_sale_events(status);
CREATE INDEX IF NOT EXISTS idx_sale_events_sku ON public.inventory_sale_events(sku_id);
GRANT SELECT ON public.inventory_sale_events TO authenticated;
GRANT ALL ON public.inventory_sale_events TO service_role;
ALTER TABLE public.inventory_sale_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read sale events" ON public.inventory_sale_events;
CREATE POLICY "auth read sale events" ON public.inventory_sale_events
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.sku_channel_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  channel text NOT NULL,
  shop_id uuid,
  external_spu_id text,
  external_item_id text,
  external_sku_id text,
  sell_channel_id text,
  stock_mode text,
  listing_status text NOT NULL DEFAULT 'draft',
  last_stock integer,
  last_stock_pushed integer,
  last_pushed_at timestamptz,
  last_verified_at timestamptz,
  last_error text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scl_listing_status_check CHECK (listing_status IN
    ('draft','publishing','published','shelved','unshelved','delisted','error'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_scl_sku_channel_shop
  ON public.sku_channel_listings(sku_id, channel, COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_scl_channel_status ON public.sku_channel_listings(channel, listing_status);
DROP TRIGGER IF EXISTS trg_scl_updated_at ON public.sku_channel_listings;
CREATE TRIGGER trg_scl_updated_at BEFORE UPDATE ON public.sku_channel_listings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
GRANT SELECT ON public.sku_channel_listings TO authenticated;
GRANT ALL ON public.sku_channel_listings TO service_role;
ALTER TABLE public.sku_channel_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read scl" ON public.sku_channel_listings;
CREATE POLICY "auth read scl" ON public.sku_channel_listings
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.channel_sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  channel_listing_id uuid REFERENCES public.sku_channel_listings(id) ON DELETE SET NULL,
  channel text NOT NULL,
  shop_id uuid,
  action text NOT NULL,
  priority smallint NOT NULL DEFAULT 5,
  inventory_version bigint NOT NULL DEFAULT 0,
  target_stock integer,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  worker_id text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_preview text,
  trace_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT cso_action_check CHECK (action IN (
    'create_hq_spu','publish_offline','publish_online','verify_listing',
    'set_stock','set_stock_zero','shelf','delist','verify_stock',
    'restore_after_return','reconcile'
  )),
  CONSTRAINT cso_status_check CHECK (status IN (
    'pending','running','succeeded','retry_wait','dead_letter','superseded','cancelled'
  ))
);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_cso_dedupe ON public.channel_sync_outbox(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_cso_claim
  ON public.channel_sync_outbox(status, priority, next_run_at)
  WHERE status IN ('pending','retry_wait');
CREATE INDEX IF NOT EXISTS idx_cso_sku ON public.channel_sync_outbox(sku_id);
DROP TRIGGER IF EXISTS trg_cso_updated_at ON public.channel_sync_outbox;
CREATE TRIGGER trg_cso_updated_at BEFORE UPDATE ON public.channel_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
GRANT SELECT ON public.channel_sync_outbox TO authenticated;
GRANT ALL ON public.channel_sync_outbox TO service_role;
ALTER TABLE public.channel_sync_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read outbox" ON public.channel_sync_outbox;
CREATE POLICY "auth read outbox" ON public.channel_sync_outbox
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.return_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_event_id uuid REFERENCES public.inventory_sale_events(id) ON DELETE SET NULL,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  epc text,
  refund_source_channel text,
  refund_source_order_id text,
  refund_status text,
  physical_status text,
  inspection_result text,
  inspector_id uuid,
  restock_location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  grade_changed boolean NOT NULL DEFAULT false,
  price_changed boolean NOT NULL DEFAULT false,
  images_changed boolean NOT NULL DEFAULT false,
  notes text,
  restock_movement_id uuid,
  channel_restore_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ri_sku ON public.return_inspections(sku_id);
CREATE INDEX IF NOT EXISTS idx_ri_result ON public.return_inspections(inspection_result);
DROP TRIGGER IF EXISTS trg_ri_updated_at ON public.return_inspections;
CREATE TRIGGER trg_ri_updated_at BEFORE UPDATE ON public.return_inspections
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
GRANT SELECT ON public.return_inspections TO authenticated;
GRANT ALL ON public.return_inspections TO service_role;
ALTER TABLE public.return_inspections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read ri" ON public.return_inspections;
CREATE POLICY "auth read ri" ON public.return_inspections
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.claim_channel_sync_tasks(
  p_worker_id text,
  p_limit int DEFAULT 10,
  p_lease_seconds int DEFAULT 60
) RETURNS SETOF public.channel_sync_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM public.channel_sync_outbox
     WHERE status IN ('pending','retry_wait')
       AND next_run_at <= now()
     ORDER BY priority ASC, next_run_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.channel_sync_outbox o
     SET status = 'running',
         worker_id = p_worker_id,
         claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1,
         updated_at = now()
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_sale(
  p_sku_id uuid,
  p_source_channel text,
  p_source_order_id text,
  p_source_shop_id uuid DEFAULT NULL,
  p_event_type text DEFAULT 'paid',
  p_epc text DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_raw_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.inventory_sale_events%ROWTYPE;
  v_sku public.inv_skus%ROWTYPE;
  v_new_version bigint;
  v_event_id uuid;
  v_listing record;
BEGIN
  SELECT * INTO v_existing FROM public.inventory_sale_events
   WHERE source_channel = p_source_channel
     AND source_order_id = p_source_order_id
     AND event_type = p_event_type;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', v_existing.status = 'processed',
      'idempotent', true,
      'event_id', v_existing.id,
      'status', v_existing.status
    );
  END IF;

  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.inventory_sale_events
      (source_channel, source_shop_id, source_order_id, event_type,
       sku_id, epc, raw_payload, status, error, processed_at)
    VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
            p_sku_id, p_epc, p_raw_payload, 'unmatched', 'sku not found', now())
    RETURNING id INTO v_event_id;
    RETURN jsonb_build_object('ok', false, 'error', 'sku_not_found', 'event_id', v_event_id);
  END IF;

  IF v_sku.stock_qty < 1 OR v_sku.sales_state IN ('sold','sold_syncing','retired') THEN
    INSERT INTO public.inventory_sale_events
      (source_channel, source_shop_id, source_order_id, event_type,
       sku_id, epc, raw_payload, status, error, processed_at)
    VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
            p_sku_id, p_epc, p_raw_payload, 'oversold',
            'insufficient stock or already sold', now())
    RETURNING id INTO v_event_id;
    RETURN jsonb_build_object('ok', false, 'error', 'oversold', 'event_id', v_event_id);
  END IF;

  IF p_location_id IS NOT NULL THEN
    PERFORM public.inv_apply_movement(
      p_sku_id, p_location_id, -1,
      'sale:' || p_source_channel, NULL, p_epc,
      'commit_sale ' || p_source_order_id
    );
  ELSE
    UPDATE public.inv_skus SET stock_qty = GREATEST(0, stock_qty - 1), updated_at = now()
     WHERE id = p_sku_id;
    INSERT INTO public.inv_stock_movements
      (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note, created_by)
    VALUES (p_sku_id, NULL, -1, GREATEST(0, v_sku.stock_qty - 1),
            'sale:' || p_source_channel, NULL, p_epc,
            'commit_sale ' || p_source_order_id, auth.uid());
  END IF;

  UPDATE public.inv_skus
     SET inventory_version = inventory_version + 1,
         sales_state = 'sold_syncing',
         updated_at = now()
   WHERE id = p_sku_id
  RETURNING inventory_version INTO v_new_version;

  INSERT INTO public.inventory_sale_events
    (source_channel, source_shop_id, source_order_id, event_type,
     sku_id, epc, raw_payload, status, processed_at)
  VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
          p_sku_id, p_epc, p_raw_payload, 'processed', now())
  RETURNING id INTO v_event_id;

  FOR v_listing IN
    SELECT id, channel, shop_id FROM public.sku_channel_listings
     WHERE sku_id = p_sku_id
       AND listing_status IN ('published','shelved','unshelved')
  LOOP
    INSERT INTO public.channel_sync_outbox
      (sku_id, channel_listing_id, channel, shop_id, action,
       priority, inventory_version, target_stock, dedupe_key)
    VALUES (p_sku_id, v_listing.id, v_listing.channel, v_listing.shop_id,
            'set_stock_zero', 1, v_new_version, 0,
            p_sku_id::text || ':' || v_listing.id::text || ':set_stock_zero:' || v_new_version::text)
    ON CONFLICT (dedupe_key) DO NOTHING;

    INSERT INTO public.channel_sync_outbox
      (sku_id, channel_listing_id, channel, shop_id, action,
       priority, inventory_version, dedupe_key)
    VALUES (p_sku_id, v_listing.id, v_listing.channel, v_listing.shop_id,
            'delist', 1, v_new_version,
            p_sku_id::text || ':' || v_listing.id::text || ':delist:' || v_new_version::text)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'inventory_version', v_new_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_after_return_inspection(
  p_inspection_id uuid,
  p_location_id uuid,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ri public.return_inspections%ROWTYPE;
  v_new_version bigint;
  v_listing record;
BEGIN
  SELECT * INTO v_ri FROM public.return_inspections WHERE id = p_inspection_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inspection_not_found');
  END IF;
  IF v_ri.inspection_result = 'pass' AND v_ri.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;

  PERFORM public.inv_apply_movement(
    v_ri.sku_id, p_location_id, 1,
    'return_inspection', v_ri.id, v_ri.epc,
    COALESCE(p_notes, 'return inspection pass')
  );

  UPDATE public.inv_skus
     SET inventory_version = inventory_version + 1,
         sales_state = 'publishing',
         updated_at = now()
   WHERE id = v_ri.sku_id
  RETURNING inventory_version INTO v_new_version;

  UPDATE public.return_inspections
     SET inspection_result = 'pass',
         restock_location_id = p_location_id,
         channel_restore_status = 'pending',
         completed_at = now(),
         updated_at = now(),
         notes = COALESCE(p_notes, notes)
   WHERE id = p_inspection_id;

  FOR v_listing IN
    SELECT id, channel, shop_id FROM public.sku_channel_listings
     WHERE sku_id = v_ri.sku_id
  LOOP
    INSERT INTO public.channel_sync_outbox
      (sku_id, channel_listing_id, channel, shop_id, action,
       priority, inventory_version, target_stock, dedupe_key)
    VALUES (v_ri.sku_id, v_listing.id, v_listing.channel, v_listing.shop_id,
            'restore_after_return', 3, v_new_version, 1,
            v_ri.sku_id::text || ':' || v_listing.id::text || ':restore_after_return:' || v_new_version::text)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inventory_version', v_new_version);
END;
$$;

-- ---- legacy 快照迁移（yz_item_id 对 hq_spu 承担 spu_id 角色） ---------------
INSERT INTO public.sku_channel_listings
  (sku_id, channel, shop_id, external_spu_id, external_item_id, external_sku_id,
   listing_status, last_stock, last_pushed_at, last_error, extra)
SELECT l.sku_id,
       CASE WHEN l.role = 'hq_spu' THEN 'youzan_hq' ELSE 'youzan_offline' END,
       l.shop_id,
       CASE WHEN l.role = 'hq_spu' THEN l.yz_item_id::text ELSE NULL END,
       l.yz_item_id::text,
       l.yz_sku_id::text,
       CASE WHEN l.status = 'linked' THEN 'published'
            WHEN l.status = 'mismatch' THEN 'published'
            ELSE 'error' END,
       l.last_pushed_stock,
       l.last_pushed_at,
       l.last_error,
       jsonb_build_object('migrated_from', 'sku_youzan_links', 'legacy_id', l.id)
  FROM public.sku_youzan_links l
 WHERE NOT EXISTS (
   SELECT 1 FROM public.sku_channel_listings s
    WHERE s.sku_id = l.sku_id
      AND s.channel = CASE WHEN l.role = 'hq_spu' THEN 'youzan_hq' ELSE 'youzan_offline' END
      AND COALESCE(s.shop_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(l.shop_id, '00000000-0000-0000-0000-000000000000'::uuid)
 );
