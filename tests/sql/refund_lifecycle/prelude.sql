-- 本地隔离库前置：角色与生产函数依赖的最小桩（非被测对象）。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE FUNCTION public.gen_commerce_after_sale_no() RETURNS text LANGUAGE sql AS $$ SELECT 'AS'||md5(random()::text) $$;
CREATE FUNCTION public.gen_commerce_order_no() RETURNS text LANGUAGE sql AS $$ SELECT 'SO'||md5(random()::text) $$;
CREATE TABLE public.commerce_order_status_audit (id uuid DEFAULT gen_random_uuid(), order_id uuid, from_status text, to_status text, reason text, evidence jsonb, created_at timestamptz DEFAULT now());
