-- inventory_delete_unused_sku 与 inv_skus DELETE 策略反例（隔离库 inv_delete_test）
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', u::text, false);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.try_rpc(s uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.inventory_delete_unused_sku(s);
  RETURN 'deleted';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ':' || SQLERRM;
END $$;

DO $$
DECLARE
  hq uuid := gen_random_uuid(); admin uuid := gen_random_uuid(); staff uuid := gen_random_uuid();
  s_shop uuid; s_ref uuid; s_free uuid; s_free2 uuid; s_mv uuid; s_part uuid; s_zero uuid; r text; n int;
BEGIN
  INSERT INTO user_roles(user_id, role) VALUES (hq,'hq_operator'),(admin,'super_admin'),(staff,'store_staff');
  INSERT INTO inv_skus(stock_qty) VALUES (0) RETURNING id INTO s_shop;
  INSERT INTO inv_stocks VALUES (s_shop, gen_random_uuid(), 1);
  INSERT INTO inv_skus DEFAULT VALUES RETURNING id INTO s_ref;
  INSERT INTO inv_label_batches(sku_id) VALUES (s_ref);
  INSERT INTO commerce_listings(sku_id) VALUES (s_ref);
  INSERT INTO inv_skus DEFAULT VALUES RETURNING id INTO s_mv;
  INSERT INTO inv_stock_movements(sku_id) VALUES (s_mv);
  INSERT INTO inv_skus DEFAULT VALUES RETURNING id INTO s_part;
  INSERT INTO inv_skus(bundle_items) VALUES (jsonb_build_array(jsonb_build_object('sku_id', s_part, 'qty', 1)));
  INSERT INTO inv_skus DEFAULT VALUES RETURNING id INTO s_free;
  INSERT INTO inv_label_batches(sku_id) VALUES (s_free);
  INSERT INTO inv_stocks VALUES (s_free, gen_random_uuid(), 0);
  INSERT INTO inv_skus DEFAULT VALUES RETURNING id INTO s_free2;
  INSERT INTO inv_skus DEFAULT VALUES RETURNING id INTO s_zero;

  EXECUTE 'SET LOCAL ROLE authenticated';

  -- 1) 门店库存 1、stock_qty 0 必须拒绝（RPC 与直连都拒绝）
  PERFORM pg_temp.as_user(hq);
  r := pg_temp.try_rpc(s_shop);
  IF r NOT LIKE 'P0001:%门店或仓库仍有库存%' THEN RAISE EXCEPTION 'FAIL shop stock: %', r; END IF;
  DELETE FROM inv_skus WHERE id = s_shop; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL direct delete bypassed shop stock'; END IF;

  -- 2) 店员拒绝（RPC 42501，直连 0 行）
  PERFORM pg_temp.as_user(staff);
  r := pg_temp.try_rpc(s_free2);
  IF r NOT LIKE '42501:仅总部管理员%' THEN RAISE EXCEPTION 'FAIL staff rpc: %', r; END IF;
  DELETE FROM inv_skus WHERE id = s_free2; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL staff direct delete'; END IF;

  -- 3) 业务引用拒绝，标签批次不丢
  PERFORM pg_temp.as_user(hq);
  r := pg_temp.try_rpc(s_ref);
  IF r NOT LIKE 'P0001:%商城上架%' THEN RAISE EXCEPTION 'FAIL listing ref: %', r; END IF;
  IF (SELECT count(*) FROM inv_label_batches WHERE sku_id = s_ref) <> 1 THEN RAISE EXCEPTION 'FAIL label lost'; END IF;
  DELETE FROM inv_skus WHERE id = s_ref; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 OR (SELECT count(*) FROM inv_label_batches WHERE sku_id = s_ref) <> 1 THEN RAISE EXCEPTION 'FAIL direct ref'; END IF;
  r := pg_temp.try_rpc(s_mv);
  IF r NOT LIKE 'P0001:%库存流水%' THEN RAISE EXCEPTION 'FAIL movement ref: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM inv_stock_movements WHERE sku_id = s_mv) THEN RAISE EXCEPTION 'FAIL movement lost'; END IF;
  r := pg_temp.try_rpc(s_part);
  IF r NOT LIKE 'P0001:%组合商品%' THEN RAISE EXCEPTION 'FAIL bundle ref: %', r; END IF;

  -- 4) 真正未使用零库存可删（RPC：hq；直连：super_admin）
  r := pg_temp.try_rpc(s_free);
  IF r <> 'deleted' OR EXISTS (SELECT 1 FROM inv_skus WHERE id = s_free) THEN RAISE EXCEPTION 'FAIL free rpc: %', r; END IF;
  PERFORM pg_temp.as_user(admin);
  DELETE FROM inv_skus WHERE id = s_zero; GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL admin direct delete unused'; END IF;

  -- 5) 不存在
  r := pg_temp.try_rpc(gen_random_uuid());
  IF r NOT LIKE 'P0002:%' THEN RAISE EXCEPTION 'FAIL missing: %', r; END IF;
  RAISE NOTICE 'PASS inventory_delete cases';
END $$;

-- 6) 权限：anon/PUBLIC 无执行权
DO $$ BEGIN
  IF has_function_privilege('anon', 'public.inventory_delete_unused_sku(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL anon exec'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.inventory_delete_unused_sku(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL auth exec'; END IF;
  RAISE NOTICE 'PASS inventory_delete grants';
END $$;
