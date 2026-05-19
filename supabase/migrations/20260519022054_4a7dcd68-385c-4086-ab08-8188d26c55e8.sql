-- 主表
CREATE TABLE public.domestic_bulk_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_name text,
  supplier_contact text,
  source_order_no text,
  purchased_at timestamptz,
  total_cny numeric,
  shipping_cny numeric,
  status text NOT NULL DEFAULT 'paid',
  carrier text,
  tracking_no text,
  receiver_name text,
  receiver_phone text,
  receiver_address text,
  delivered_at timestamptz,
  invoice_no text,
  contract_no text,
  pay_method text,
  attachment_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  completeness integer NOT NULL DEFAULT 0,
  raw_payload jsonb,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.domestic_bulk_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_domestic_bulk_orders ON public.domestic_bulk_orders FOR SELECT USING (true);
CREATE POLICY open_insert_domestic_bulk_orders ON public.domestic_bulk_orders FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_domestic_bulk_orders ON public.domestic_bulk_orders FOR UPDATE USING (true);
CREATE POLICY open_delete_domestic_bulk_orders ON public.domestic_bulk_orders FOR DELETE USING (true);

CREATE TRIGGER trg_domestic_bulk_orders_updated_at
  BEFORE UPDATE ON public.domestic_bulk_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE INDEX idx_domestic_bulk_orders_purchased_at ON public.domestic_bulk_orders (purchased_at DESC);
CREATE INDEX idx_domestic_bulk_orders_status ON public.domestic_bulk_orders (status);

-- 明细行
CREATE TABLE public.domestic_bulk_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.domestic_bulk_orders(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  item_title text,
  qty integer NOT NULL DEFAULT 1,
  unit_price_cny numeric,
  subtotal_cny numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.domestic_bulk_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_domestic_bulk_order_lines ON public.domestic_bulk_order_lines FOR SELECT USING (true);
CREATE POLICY open_insert_domestic_bulk_order_lines ON public.domestic_bulk_order_lines FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_domestic_bulk_order_lines ON public.domestic_bulk_order_lines FOR UPDATE USING (true);
CREATE POLICY open_delete_domestic_bulk_order_lines ON public.domestic_bulk_order_lines FOR DELETE USING (true);

CREATE INDEX idx_domestic_bulk_order_lines_order_id ON public.domestic_bulk_order_lines (order_id);

-- 附件 bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('domestic-bulk-attachments', 'domestic-bulk-attachments', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "domestic_bulk_attachments_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'domestic-bulk-attachments');

CREATE POLICY "domestic_bulk_attachments_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'domestic-bulk-attachments');

CREATE POLICY "domestic_bulk_attachments_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'domestic-bulk-attachments');

CREATE POLICY "domestic_bulk_attachments_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'domestic-bulk-attachments');