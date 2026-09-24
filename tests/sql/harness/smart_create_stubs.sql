-- 隔离测试专用（独立库 smart_create_test，绝不在生产执行）：智能上架幂等 / outbox / 重复撤销所需最小结构。
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.inv_locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL DEFAULT 'shop', shop_id uuid);
CREATE TABLE public.inv_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category text NOT NULL, price_tier numeric NOT NULL, name text NOT NULL,
  kind text NOT NULL DEFAULT 'single', epc text NOT NULL, weight_g numeric, image_url text, stock_qty integer NOT NULL DEFAULT 0,
  notes text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')), is_custom_price boolean NOT NULL DEFAULT false,
  sku_code text, grade text, barcode text, image_paths text[] NOT NULL DEFAULT '{}', is_display boolean NOT NULL DEFAULT true,
  attributes jsonb NOT NULL DEFAULT '{}', category_source text NOT NULL DEFAULT 'legacy', category_confidence numeric,
  classification_status text NOT NULL DEFAULT 'legacy', ai_suggested_price numeric, recognition_request_id uuid,
  inventory_policy text NOT NULL DEFAULT 'tracked', ip_id uuid, ip_candidate_text text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.inv_stocks (sku_id uuid NOT NULL REFERENCES public.inv_skus(id), location_id uuid NOT NULL, qty integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(), PRIMARY KEY (sku_id, location_id));
CREATE TABLE public.inv_stock_movements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid REFERENCES public.inv_skus(id),
  location_id uuid, delta integer, balance_after integer, ref_type text CHECK (ref_type IN ('manual_adjust','handheld_smart_create','x')), ref_id uuid, epc text, note text, created_by uuid,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.inv_epcs (epc text PRIMARY KEY, sku_id uuid REFERENCES public.inv_skus(id), current_location_id uuid,
  status text NOT NULL DEFAULT 'unclaimed', last_seen_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.commerce_listings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid REFERENCES public.inv_skus(id),
  location_id uuid, status text NOT NULL DEFAULT 'published', updated_at timestamptz DEFAULT now(), UNIQUE (sku_id, location_id));
CREATE TABLE public.sku_youzan_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid REFERENCES public.inv_skus(id), shop_id uuid);
CREATE TABLE public.commerce_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid);
CREATE TABLE public.inventory_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid);
CREATE TABLE public.inventory_reservation_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stock_sku_id uuid);
CREATE TABLE public.inventory_sale_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid);
CREATE TABLE public.stock_transfer_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid);

-- 与线上 inv_apply_movement 相同的库存语义；上架同步简化为：正向智能上架发布一条 listing。
CREATE FUNCTION public.inv_apply_movement(p_sku_id uuid, p_location_id uuid, p_delta integer, p_ref_type text,
  p_ref_id uuid, p_epc text DEFAULT NULL, p_note text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new integer; v_policy text;
BEGIN
  SELECT inventory_policy INTO v_policy FROM public.inv_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SKU not found'; END IF;
  IF v_policy = 'unlimited' THEN RETURN 0; END IF;
  INSERT INTO public.inv_stocks (sku_id, location_id, qty) VALUES (p_sku_id, p_location_id, p_delta)
  ON CONFLICT (sku_id, location_id) DO UPDATE SET qty = inv_stocks.qty + EXCLUDED.qty, updated_at = now()
  RETURNING qty INTO v_new;
  INSERT INTO public.inv_stock_movements (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note)
  VALUES (p_sku_id, p_location_id, p_delta, v_new, p_ref_type, p_ref_id, p_epc, p_note);
  IF p_ref_type = 'handheld_smart_create' AND p_delta > 0 THEN
    INSERT INTO public.commerce_listings (sku_id, location_id) VALUES (p_sku_id, p_location_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN v_new;
END $$;
