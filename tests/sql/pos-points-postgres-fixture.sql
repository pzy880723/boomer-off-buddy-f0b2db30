-- Additional schema for the real PostgreSQL harness. All data is synthetic.
-- Replaces the PGlite stock stubs with committed production function definitions.
DROP FUNCTION public.inv_apply_movement(uuid,uuid,integer,text,uuid,text,text);
DROP FUNCTION public.sales_sku_available_qty(uuid,uuid);
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
ALTER TABLE inv_locations ADD COLUMN kind text DEFAULT 'shop';
ALTER TABLE inv_skus ADD COLUMN stock_qty integer DEFAULT 0;
ALTER TABLE inv_stocks ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE commerce_membership_plans ADD COLUMN points_multiplier numeric DEFAULT 1;
CREATE TABLE inv_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sku_id uuid,location_id uuid,
  delta integer,balance_after integer,ref_type text,ref_id uuid,epc text,note text,created_by uuid
);
CREATE TABLE inventory_reservations(id uuid PRIMARY KEY,status text,expires_at timestamptz);
CREATE TABLE inventory_reservation_lines(reservation_id uuid,stock_sku_id uuid,location_id uuid,quantity integer);
