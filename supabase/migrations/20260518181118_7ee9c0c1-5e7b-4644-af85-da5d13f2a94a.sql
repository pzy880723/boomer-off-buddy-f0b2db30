
-- SKU 档案
CREATE TABLE public.inv_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  price_tier numeric(10,2) NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'single' CHECK (kind IN ('single','pack')),
  pack_pieces integer,
  epc text NOT NULL UNIQUE,
  weight_g numeric(10,2),
  image_url text,
  stock_qty integer NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, price_tier, name)
);

CREATE INDEX idx_inv_skus_category ON public.inv_skus(category);
CREATE INDEX idx_inv_skus_price_tier ON public.inv_skus(price_tier);

ALTER TABLE public.inv_skus ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_select_inv_skus ON public.inv_skus FOR SELECT USING (true);
CREATE POLICY open_insert_inv_skus ON public.inv_skus FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_inv_skus ON public.inv_skus FOR UPDATE USING (true);
CREATE POLICY open_delete_inv_skus ON public.inv_skus FOR DELETE USING (true);

CREATE TRIGGER trg_inv_skus_updated BEFORE UPDATE ON public.inv_skus
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- RFID 标签打印批
CREATE TABLE public.inv_label_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  qty integer NOT NULL CHECK (qty > 0),
  operator text,
  status text NOT NULL DEFAULT 'printed' CHECK (status IN ('printed','scanned_in','cancelled')),
  notes text,
  printed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_label_batches_sku ON public.inv_label_batches(sku_id);

ALTER TABLE public.inv_label_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_select_inv_label_batches ON public.inv_label_batches FOR SELECT USING (true);
CREATE POLICY open_insert_inv_label_batches ON public.inv_label_batches FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_inv_label_batches ON public.inv_label_batches FOR UPDATE USING (true);
CREATE POLICY open_delete_inv_label_batches ON public.inv_label_batches FOR DELETE USING (true);

CREATE TRIGGER trg_inv_label_batches_updated BEFORE UPDATE ON public.inv_label_batches
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 入库单
CREATE TABLE public.inv_inbound_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text,
  operator text,
  total_qty integer NOT NULL DEFAULT 0,
  total_value_cny numeric(12,2) NOT NULL DEFAULT 0,
  notes text,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inv_inbound_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_select_inv_inbound_orders ON public.inv_inbound_orders FOR SELECT USING (true);
CREATE POLICY open_insert_inv_inbound_orders ON public.inv_inbound_orders FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_inv_inbound_orders ON public.inv_inbound_orders FOR UPDATE USING (true);
CREATE POLICY open_delete_inv_inbound_orders ON public.inv_inbound_orders FOR DELETE USING (true);

CREATE TRIGGER trg_inv_inbound_orders_updated BEFORE UPDATE ON public.inv_inbound_orders
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 入库单明细
CREATE TABLE public.inv_inbound_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.inv_inbound_orders(id) ON DELETE CASCADE,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id),
  qty integer NOT NULL CHECK (qty > 0),
  unit_price numeric(10,2) NOT NULL DEFAULT 0,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_inbound_lines_order ON public.inv_inbound_lines(order_id);
CREATE INDEX idx_inv_inbound_lines_sku ON public.inv_inbound_lines(sku_id);

ALTER TABLE public.inv_inbound_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_select_inv_inbound_lines ON public.inv_inbound_lines FOR SELECT USING (true);
CREATE POLICY open_insert_inv_inbound_lines ON public.inv_inbound_lines FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_inv_inbound_lines ON public.inv_inbound_lines FOR UPDATE USING (true);
CREATE POLICY open_delete_inv_inbound_lines ON public.inv_inbound_lines FOR DELETE USING (true);

-- 并发安全地累加库存
CREATE OR REPLACE FUNCTION public.inv_apply_inbound_stock(p_sku_id uuid, p_delta integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.inv_skus
    SET stock_qty = stock_qty + p_delta,
        updated_at = now()
  WHERE id = p_sku_id;
END;
$$;
