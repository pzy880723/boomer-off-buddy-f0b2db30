-- 隔离夹具：inv_skus/inv_stocks/commerce_listings/inv_locations 取自实际库只读裁剪的 real_schema.sql；
-- inv_listing_image_jobs / inv_product_content 按实际库列定义（information_schema 只读读取）。
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TYPE public.app_role AS ENUM ('super_admin','hq_operator','store_manager','store_staff','warehouse_staff');
\ir ../measurement_rpc/real_schema.sql
CREATE TABLE public.inv_listing_image_jobs (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, sku_id uuid NOT NULL,
  source_bucket text NOT NULL, source_path text NOT NULL, source_index integer DEFAULT 0 NOT NULL,
  target_bucket text DEFAULT 'sku-listing' NOT NULL, target_path text, status text DEFAULT 'queued' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL, next_run_at timestamptz DEFAULT now() NOT NULL, locked_at timestamptz,
  locked_by text, last_error text, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  completed_at timestamptz, claim_token uuid, lease_until timestamptz, ai_actor_user_id uuid, ai_policy_version text);
CREATE TABLE public.inv_product_content (sku_id uuid PRIMARY KEY, version integer DEFAULT 0 NOT NULL,
  draft_blocks jsonb DEFAULT '[]' NOT NULL, published_blocks jsonb DEFAULT '[]' NOT NULL, published_version integer,
  updated_by uuid, updated_at timestamptz DEFAULT now() NOT NULL);
ALTER TABLE public.commerce_listings ADD CONSTRAINT cl_status_chk CHECK (status = ANY (ARRAY['draft','published','reserved','sold','hidden','archived']));
INSERT INTO inv_locations (id, kind, name) VALUES ('00000000-0000-0000-0000-00000000000a','shop','A店');
