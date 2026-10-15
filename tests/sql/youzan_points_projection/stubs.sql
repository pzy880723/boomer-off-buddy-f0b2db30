-- 隔离库结构桩（仅本机临时集群，无任何生产数据）
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.commerce_customers(id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active');
CREATE TABLE public.pos_customer_wallets(customer_id uuid PRIMARY KEY, points integer NOT NULL DEFAULT 0);
