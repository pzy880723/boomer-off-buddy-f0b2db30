-- 隔离并发测试用桩函数：只为让生产表结构能在本地空库中重建。
-- 绝不在生产库执行（仅 tests/sql/run.sh 在本地 5.5 万端口的临时库里使用）。
-- 隔离集群里补齐迁移会 GRANT/REVOKE 的角色（本地测试用，均不可登录）
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE OR REPLACE FUNCTION public.gen_commerce_after_sale_no() RETURNS text
LANGUAGE sql AS $$ SELECT 'AS' || to_char(clock_timestamp(),'YYYYMMDDHH24MISSUS') || floor(random()*1000)::text $$;

CREATE OR REPLACE FUNCTION public.gen_commerce_order_no() RETURNS text
LANGUAGE sql AS $$ SELECT 'SO' || to_char(clock_timestamp(),'YYYYMMDDHH24MISSUS') || floor(random()*1000)::text $$;

CREATE OR REPLACE FUNCTION public.tg_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.tg_fulfillment_shortage_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.tg_fulfillment_enqueue_pick_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.commerce_ordinary_immutable_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.commerce_assign_storefront_customer() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION public.commerce_resolve_order_coupon() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
