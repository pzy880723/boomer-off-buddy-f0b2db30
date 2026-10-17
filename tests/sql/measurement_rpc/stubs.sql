-- 隔离测试夹具：表结构来自 real_schema.sql（实际库裁剪，inv_skus 无 location_id），本文件只放角色与种子数据。
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TYPE public.app_role AS ENUM ('super_admin','hq_operator','store_manager','store_staff','warehouse_staff');
\ir real_schema.sql

INSERT INTO inv_locations (id, kind, name) VALUES
  ('00000000-0000-0000-0000-00000000000a','shop','A店'),
  ('00000000-0000-0000-0000-00000000000b','shop','B店'),
  ('00000000-0000-0000-0000-00000000000c','shop','C店');
INSERT INTO commerce_customers (id, external_subject) VALUES
  ('00000000-0000-0000-0000-000000000021','subA'),
  ('00000000-0000-0000-0000-000000000022','subB'),
  ('00000000-0000-0000-0000-000000000023','subC');
-- 员工：ff01 仅 A 店，ff02 仅 B 店，ff09 总部
INSERT INTO user_location_perms (user_id, location_id) VALUES
  ('00000000-0000-0000-0000-00000000ff01','00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000ff02','00000000-0000-0000-0000-00000000000b');
INSERT INTO user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000ff01','store_staff'),
  ('00000000-0000-0000-0000-00000000ff02','store_staff'),
  ('00000000-0000-0000-0000-00000000ff09','super_admin');

-- 造商品：sku 名称、listing(location 为 listing 归属)、inv_stocks 分布
CREATE FUNCTION public.test_mk(p_n int, p_listing_loc char, p_stock text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s uuid := ('00000000-0000-0000-0000-0000000001' || lpad(p_n::text,2,'0'))::uuid;
        l uuid := ('00000000-0000-0000-0000-0000000002' || lpad(p_n::text,2,'0'))::uuid;
        kv text;
BEGIN
  INSERT INTO inv_skus (id, epc, category, price_tier, name, is_custom_price) VALUES (s, 'TESTEPC'||p_n, 'test', 10, '商品'||p_n, true);
  INSERT INTO commerce_listings (id, sku_id, location_id, title, price, status, published_at)
  VALUES (l, s, ('00000000-0000-0000-0000-00000000000' || lower(p_listing_loc))::uuid, '商品'||p_n, 10, 'published', now());
  FOREACH kv IN ARRAY string_to_array(p_stock, ',') LOOP
    INSERT INTO inv_stocks (sku_id, location_id, qty)
    VALUES (s, ('00000000-0000-0000-0000-00000000000' || lower(split_part(kv,'=',1)))::uuid, split_part(kv,'=',2)::int);
  END LOOP;
END $f$;

CREATE FUNCTION public.test_expect_err(p_sql text, p_pat text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%' || p_pat || '%' THEN RETURN; END IF;
    RAISE EXCEPTION 'FAIL expected % got %', p_pat, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL expected % but succeeded: %', p_pat, p_sql;
END $f$;
CREATE FUNCTION public.s(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('00000000-0000-0000-0000-0000000001' || lpad(n::text,2,'0'))::uuid $f$;
CREATE FUNCTION public.l(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('00000000-0000-0000-0000-0000000002' || lpad(n::text,2,'0'))::uuid $f$;
CREATE FUNCTION public.loc(c text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('00000000-0000-0000-0000-00000000000' || c)::uuid $f$;
CREATE FUNCTION public.cu(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('00000000-0000-0000-0000-00000000002' || n)::uuid $f$;
CREATE FUNCTION public.st(c text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('00000000-0000-0000-0000-00000000ff0' || c)::uuid $f$;
