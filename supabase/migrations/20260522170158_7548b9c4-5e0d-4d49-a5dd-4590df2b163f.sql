
CREATE TABLE public.stock_transfers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('wh_to_shop','shop_to_shop','shop_to_wh','consume')),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','failed','void')),
  from_shop_id uuid REFERENCES public.youzan_shops(id) ON DELETE SET NULL,
  to_shop_id uuid REFERENCES public.youzan_shops(id) ON DELETE SET NULL,
  from_sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  to_sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  from_youzan_item_id bigint,
  to_youzan_item_id bigint,
  qty integer NOT NULL CHECK (qty > 0),
  reason text,
  operator text,
  notes text,
  youzan_sync_status text NOT NULL DEFAULT 'pending' CHECK (youzan_sync_status IN ('pending','ok','partial','failed','not_required')),
  youzan_error_msg text,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_transfers_created_at ON public.stock_transfers(created_at DESC);
CREATE INDEX idx_stock_transfers_from_shop ON public.stock_transfers(from_shop_id);
CREATE INDEX idx_stock_transfers_to_shop ON public.stock_transfers(to_shop_id);

ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_stock_transfers ON public.stock_transfers FOR SELECT USING (true);
CREATE POLICY open_insert_stock_transfers ON public.stock_transfers FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_stock_transfers ON public.stock_transfers FOR UPDATE USING (true);
CREATE POLICY open_delete_stock_transfers ON public.stock_transfers FOR DELETE USING (true);

CREATE TRIGGER tg_stock_transfers_updated_at
  BEFORE UPDATE ON public.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 单号生成函数：T-YYYYMMDD-NNNN
CREATE OR REPLACE FUNCTION public.gen_stock_transfer_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d text := to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD');
  n int;
BEGIN
  SELECT COUNT(*) + 1 INTO n
  FROM public.stock_transfers
  WHERE code LIKE 'T-' || d || '-%';
  RETURN 'T-' || d || '-' || lpad(n::text, 4, '0');
END;
$$;

-- 仓库库存增减（与 inv_apply_inbound_stock 一致，支持负数）
CREATE OR REPLACE FUNCTION public.inv_apply_stock_delta(p_sku_id uuid, p_delta integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.inv_skus
    SET stock_qty = GREATEST(0, stock_qty + p_delta),
        updated_at = now()
  WHERE id = p_sku_id;
END;
$$;
