-- 热门发现隔离测试最小结构；绝不连接生产库。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE commerce_customers (id uuid PRIMARY KEY);
CREATE TABLE commerce_listings (id uuid PRIMARY KEY, status text DEFAULT 'published');
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON commerce_customers, commerce_listings TO service_role;
