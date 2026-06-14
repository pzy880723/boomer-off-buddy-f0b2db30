
CREATE TABLE public.inv_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('warehouse','shop')),
  name text NOT NULL,
  shop_id uuid REFERENCES public.youzan_shops(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id)
);
CREATE INDEX idx_inv_locations_kind ON public.inv_locations(kind);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_locations TO authenticated;
GRANT ALL ON public.inv_locations TO service_role;
ALTER TABLE public.inv_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_inv_locations" ON public.inv_locations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_inv_locations_updated BEFORE UPDATE ON public.inv_locations FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.inv_stocks (
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id)
);
CREATE INDEX idx_inv_stocks_location ON public.inv_stocks(location_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_stocks TO authenticated;
GRANT ALL ON public.inv_stocks TO service_role;
ALTER TABLE public.inv_stocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_inv_stocks" ON public.inv_stocks FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.inv_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  delta integer NOT NULL,
  balance_after integer NOT NULL,
  ref_type text NOT NULL CHECK (ref_type IN (
    'rfid_inbound','transfer_out','transfer_in',
    'stocktake_adjust','youzan_sale','unclaim','manual_adjust'
  )),
  ref_id uuid,
  epc text,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_movements_sku ON public.inv_stock_movements(sku_id, created_at DESC);
CREATE INDEX idx_movements_location ON public.inv_stock_movements(location_id, created_at DESC);
CREATE INDEX idx_movements_ref ON public.inv_stock_movements(ref_type, ref_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_stock_movements TO authenticated;
GRANT ALL ON public.inv_stock_movements TO service_role;
ALTER TABLE public.inv_stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_inv_stock_movements" ON public.inv_stock_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.inv_epcs (
  epc text PRIMARY KEY,
  sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  current_location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'unclaimed' CHECK (status IN ('unclaimed','in_stock','in_transit','sold','lost')),
  label_batch_id uuid REFERENCES public.inv_label_batches(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_epcs_sku ON public.inv_epcs(sku_id);
CREATE INDEX idx_epcs_location ON public.inv_epcs(current_location_id);
CREATE INDEX idx_epcs_status ON public.inv_epcs(status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_epcs TO authenticated;
GRANT ALL ON public.inv_epcs TO service_role;
ALTER TABLE public.inv_epcs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_inv_epcs" ON public.inv_epcs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_inv_epcs_updated BEFORE UPDATE ON public.inv_epcs FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.inv_unclaimed_epcs (
  epc text PRIMARY KEY,
  last_seen_location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  hits integer NOT NULL DEFAULT 1,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_unclaimed_last_seen ON public.inv_unclaimed_epcs(last_seen_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_unclaimed_epcs TO authenticated;
GRANT ALL ON public.inv_unclaimed_epcs TO service_role;
ALTER TABLE public.inv_unclaimed_epcs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_inv_unclaimed_epcs" ON public.inv_unclaimed_epcs FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.inv_handheld_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code text NOT NULL UNIQUE,
  label text NOT NULL,
  default_location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  token text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_handheld_devices TO authenticated;
GRANT ALL ON public.inv_handheld_devices TO service_role;
ALTER TABLE public.inv_handheld_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_inv_handheld_devices" ON public.inv_handheld_devices FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_inv_handheld_devices_updated BEFORE UPDATE ON public.inv_handheld_devices FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  expected_qty integer NOT NULL DEFAULT 0,
  shipped_qty integer NOT NULL DEFAULT 0,
  received_qty integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, sku_id)
);
CREATE INDEX idx_transfer_lines_transfer ON public.stock_transfer_lines(transfer_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_transfer_lines TO authenticated;
GRANT ALL ON public.stock_transfer_lines TO service_role;
ALTER TABLE public.stock_transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_stock_transfer_lines" ON public.stock_transfer_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.stock_transfer_epcs (
  transfer_id uuid NOT NULL REFERENCES public.stock_transfers(id) ON DELETE CASCADE,
  epc text NOT NULL,
  sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  ship_scanned_at timestamptz,
  receive_scanned_at timestamptz,
  PRIMARY KEY (transfer_id, epc)
);
CREATE INDEX idx_transfer_epcs_epc ON public.stock_transfer_epcs(epc);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_transfer_epcs TO authenticated;
GRANT ALL ON public.stock_transfer_epcs TO service_role;
ALTER TABLE public.stock_transfer_epcs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_stock_transfer_epcs" ON public.stock_transfer_epcs FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  status text NOT NULL DEFAULT 'scanning' CHECK (status IN ('scanning','submitted','approved','rejected')),
  opened_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stocktakes_location ON public.stocktakes(location_id);
CREATE INDEX idx_stocktakes_status ON public.stocktakes(status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stocktakes TO authenticated;
GRANT ALL ON public.stocktakes TO service_role;
ALTER TABLE public.stocktakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_stocktakes" ON public.stocktakes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_stocktakes_updated BEFORE UPDATE ON public.stocktakes FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE public.stocktake_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES public.stocktakes(id) ON DELETE CASCADE,
  epc text NOT NULL,
  sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stocktake_id, epc)
);
CREATE INDEX idx_stocktake_scans_stocktake ON public.stocktake_scans(stocktake_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stocktake_scans TO authenticated;
GRANT ALL ON public.stocktake_scans TO service_role;
ALTER TABLE public.stocktake_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_stocktake_scans" ON public.stocktake_scans FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.stocktake_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES public.stocktakes(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  system_qty integer NOT NULL DEFAULT 0,
  counted_qty integer NOT NULL DEFAULT 0,
  diff integer NOT NULL DEFAULT 0,
  reason text,
  UNIQUE (stocktake_id, sku_id)
);
CREATE INDEX idx_stocktake_lines_stocktake ON public.stocktake_lines(stocktake_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stocktake_lines TO authenticated;
GRANT ALL ON public.stocktake_lines TO service_role;
ALTER TABLE public.stocktake_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_stocktake_lines" ON public.stocktake_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.stock_transfers
  ADD COLUMN IF NOT EXISTS from_location_id uuid REFERENCES public.inv_locations(id),
  ADD COLUMN IF NOT EXISTS to_location_id uuid REFERENCES public.inv_locations(id),
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipped_by uuid,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS received_by uuid;

ALTER TABLE public.stock_transfers DROP CONSTRAINT IF EXISTS stock_transfers_status_check;
ALTER TABLE public.stock_transfers
  ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('draft','in_transit','received','cancelled','posted'));

ALTER TABLE public.inv_inbound_orders
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.inv_locations(id),
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.inv_handheld_devices(id);

CREATE OR REPLACE FUNCTION public.inv_apply_movement(
  p_sku_id uuid,
  p_location_id uuid,
  p_delta integer,
  p_ref_type text,
  p_ref_id uuid,
  p_epc text DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new integer;
BEGIN
  INSERT INTO public.inv_stocks (sku_id, location_id, qty, updated_at)
  VALUES (p_sku_id, p_location_id, p_delta, now())
  ON CONFLICT (sku_id, location_id)
  DO UPDATE SET qty = inv_stocks.qty + EXCLUDED.qty, updated_at = now()
  RETURNING qty INTO v_new;

  INSERT INTO public.inv_stock_movements
    (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note, created_by)
  VALUES
    (p_sku_id, p_location_id, p_delta, v_new, p_ref_type, p_ref_id, p_epc, p_note, auth.uid());

  IF EXISTS (SELECT 1 FROM public.inv_locations WHERE id = p_location_id AND kind = 'warehouse') THEN
    UPDATE public.inv_skus SET stock_qty = GREATEST(0, stock_qty + p_delta), updated_at = now()
      WHERE id = p_sku_id;
  END IF;

  RETURN v_new;
END;
$$;

DO $$
DECLARE
  v_wh_id uuid;
  v_shop record;
BEGIN
  SELECT id INTO v_wh_id FROM public.inv_locations WHERE kind = 'warehouse' LIMIT 1;
  IF v_wh_id IS NULL THEN
    INSERT INTO public.inv_locations (kind, name) VALUES ('warehouse', '总仓')
    RETURNING id INTO v_wh_id;
  END IF;

  FOR v_shop IN SELECT id, shop_name FROM public.youzan_shops WHERE status = 'active' LOOP
    INSERT INTO public.inv_locations (kind, name, shop_id)
    VALUES ('shop', COALESCE(v_shop.shop_name, '门店'), v_shop.id)
    ON CONFLICT (shop_id) DO NOTHING;
  END LOOP;

  INSERT INTO public.inv_stocks (sku_id, location_id, qty)
  SELECT id, v_wh_id, stock_qty FROM public.inv_skus WHERE stock_qty > 0
  ON CONFLICT (sku_id, location_id) DO NOTHING;
END $$;

ALTER TABLE public.stock_transfers
  ALTER COLUMN code SET DEFAULT public.gen_stock_transfer_code();
