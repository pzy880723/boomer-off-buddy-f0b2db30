-- 隔离库结构桩（仅本机临时集群，无任何生产数据）
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.app_settings(key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.commerce_customers(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.pos_customer_wallets(customer_id uuid PRIMARY KEY REFERENCES public.commerce_customers(id),
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0), metadata jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.commerce_points_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES public.commerce_customers(id),
  delta integer NOT NULL CHECK (delta <> 0), balance_after integer NOT NULL CHECK (balance_after >= 0), source_type text NOT NULL,
  source_id text, idempotency_key text NOT NULL UNIQUE, description text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
