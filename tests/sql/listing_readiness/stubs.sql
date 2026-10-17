-- 隔离夹具：inv_skus/inv_stocks/commerce_listings/inv_locations 取自实际库只读裁剪的 real_schema.sql；
-- inv_listing_image_jobs / inv_product_content 按实际库列定义（information_schema 只读读取）。
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TYPE public.app_role AS ENUM ('super_admin','hq_operator','store_manager','store_staff','warehouse_staff');
\ir ../measurement_rpc/real_schema.sql
-- real_schema.sql 用唯一索引表示主键/唯一键；这里升格为约束，与真实库 pg_constraint 一致。
ALTER TABLE public.inv_skus ADD PRIMARY KEY USING INDEX inv_skus_pkey, ADD UNIQUE USING INDEX inv_skus_epc_key;
ALTER TABLE public.inv_stocks ADD PRIMARY KEY USING INDEX inv_stocks_pkey;
ALTER TABLE public.inv_locations ADD PRIMARY KEY USING INDEX inv_locations_pkey, ADD UNIQUE USING INDEX inv_locations_shop_id_key;
ALTER TABLE public.commerce_listings ADD PRIMARY KEY USING INDEX commerce_listings_pkey, ADD UNIQUE USING INDEX commerce_listings_sku_id_location_id_key;
CREATE TABLE public.inv_listing_image_jobs (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, sku_id uuid NOT NULL,
  source_bucket text NOT NULL CHECK (source_bucket = ANY (ARRAY['sku-raw','sku-listing'])), source_path text NOT NULL,
  source_index integer DEFAULT 0 NOT NULL CHECK (source_index >= 0),
  target_bucket text DEFAULT 'sku-listing' NOT NULL CHECK (target_bucket = 'sku-listing'), target_path text,
  status text DEFAULT 'queued' NOT NULL CHECK (status = ANY (ARRAY['queued','processing','succeeded','retryable_failed','permanent_failed'])),
  attempts integer DEFAULT 0 NOT NULL CHECK (attempts >= 0), next_run_at timestamptz DEFAULT now() NOT NULL, locked_at timestamptz,
  locked_by text, last_error text, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  completed_at timestamptz, claim_token uuid, lease_until timestamptz, ai_actor_user_id uuid, ai_policy_version text,
  UNIQUE (sku_id, source_bucket, source_path));
-- 与真实库完全一致（含 updated_by NOT NULL、CHECK、FK）：supabase/migrations/20260926183555_product_rich_content.sql
CREATE TABLE public.inv_product_content (
  sku_id uuid PRIMARY KEY REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  draft_blocks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(draft_blocks) = 'array'),
  published_blocks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(published_blocks) = 'array'),
  published_version integer CHECK (published_version > 0 AND published_version <= version),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.commerce_listings ADD CONSTRAINT cl_status_chk CHECK (status = ANY (ARRAY['draft','published','reserved','sold','hidden','archived']));
INSERT INTO inv_locations (id, kind, name) VALUES ('00000000-0000-0000-0000-00000000000a','shop','A店');
