-- 隔离测试专用（独立库 inv_delete_test，绝不在生产执行）：
-- 只重建 SKU 删除检查需要的最小结构；外键删除行为与线上一致（a=拒绝 / c=级联 / n=置空）。
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('super_admin','hq_operator','store_manager','store_staff','warehouse_staff');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

CREATE TABLE public.inv_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 't',
  stock_qty integer NOT NULL DEFAULT 0,
  bundle_items jsonb
);
CREATE TABLE public.inv_stocks (sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE, location_id uuid NOT NULL, qty integer NOT NULL DEFAULT 0, PRIMARY KEY (sku_id, location_id));
CREATE TABLE public.inv_label_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid REFERENCES public.inv_skus(id) ON DELETE CASCADE);
CREATE TABLE public.inv_sku_facets (sku_id uuid REFERENCES public.inv_skus(id) ON DELETE CASCADE);
CREATE TABLE public.inv_sku_classifications (sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL);
CREATE TABLE public.inv_listing_image_jobs (sku_id uuid REFERENCES public.inv_skus(id) ON DELETE CASCADE);

DO $$
DECLARE t text[];
BEGIN
  FOREACH t SLICE 1 IN ARRAY ARRAY[
    ['inv_stock_movements','sku_id','CASCADE'], ['inv_inbound_lines','sku_id','NO ACTION'],
    ['stock_transfer_lines','sku_id','NO ACTION'], ['stock_transfer_epcs','sku_id','SET NULL'],
    ['stocktake_lines','sku_id','NO ACTION'], ['stocktake_scans','sku_id','SET NULL'],
    ['inventory_sale_events','sku_id','SET NULL'], ['inventory_reservations','sku_id','NO ACTION'],
    ['inventory_reservation_lines','stock_sku_id','NO ACTION'], ['commerce_listings','sku_id','NO ACTION'],
    ['commerce_order_items','sku_id','NO ACTION'], ['fulfillment_items','sku_id','NO ACTION'],
    ['pos_held_cart_items','sku_id','NO ACTION'], ['pos_return_items','sku_id','NO ACTION'],
    ['return_inspections','sku_id','CASCADE'], ['sku_youzan_links','sku_id','CASCADE'],
    ['youzan_stock_sync_queue','sku_id','CASCADE'], ['sku_channel_listings','sku_id','CASCADE'],
    ['channel_sync_outbox','sku_id','CASCADE'], ['inv_epcs','sku_id','SET NULL']]
  LOOP
    EXECUTE format('CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), %I uuid REFERENCES public.inv_skus(id) ON DELETE %s)', t[1], t[2], t[3]);
  END LOOP;
END $$;
CREATE TABLE public.stock_transfers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  to_sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL);

ALTER TABLE public.inv_skus ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_select_inv_skus ON public.inv_skus FOR SELECT TO authenticated USING (true);
CREATE POLICY auth_delete_inv_skus ON public.inv_skus FOR DELETE TO authenticated USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
