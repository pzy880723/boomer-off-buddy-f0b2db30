-- 门店坐标总部管理员权限：数据库实际角色测试（全部在事务内，末尾强制 RAISE 回滚，无残留）。
-- 以 authenticated / anon 数据库角色 + request.jwt.claims 模拟数据 API 直连（REST 绕过）路径。
-- 夹具：借用一个现有 super_admin 用户，在事务内临时把其角色替换为被测角色，回滚后复原。
DO $$
DECLARE
  shop uuid; u uuid; out text := ''; t0 timestamptz; t1 timestamptz; n int;
  r text;
BEGIN
  SELECT id INTO shop FROM public.youzan_shops ORDER BY id LIMIT 1;
  SELECT user_id INTO u FROM public.user_roles WHERE role='super_admin' ORDER BY user_id LIMIT 1;

  -- 非管理员角色：store_manager / store_staff / hq_operator / 无角色+伪造 metadata
  FOREACH r IN ARRAY ARRAY['store_manager','store_staff','hq_operator','forged_meta'] LOOP
    DELETE FROM public.user_roles WHERE user_id=u;
    IF r <> 'forged_meta' THEN
      INSERT INTO public.user_roles(user_id, role) VALUES (u, r::public.app_role);
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object(
      'sub', u, 'role', 'authenticated',
      'user_metadata', json_build_object('role','super_admin'),
      'app_metadata', json_build_object('role','super_admin'))::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE public.youzan_shops SET latitude=31.2, longitude=121.4, coord_system='gcj02' WHERE id=shop;
      GET DIAGNOSTICS n = ROW_COUNT;
      out := out || r || '_coord=ACCEPTED(' || n || ');';
    EXCEPTION WHEN insufficient_privilege THEN out := out || r || '_coord=rejected;'; END;
    -- 无坐标的无关字段更新保持原行为（现有 RLS 允许登录用户更新）
    UPDATE public.youzan_shops SET notes = notes WHERE id=shop;
    GET DIAGNOSTICS n = ROW_COUNT;
    out := out || r || '_noncoord_rows=' || n || ';';
    RESET ROLE;
  END LOOP;

  -- 匿名
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  BEGIN
    UPDATE public.youzan_shops SET latitude=31.2, longitude=121.4, coord_system='gcj02' WHERE id=shop;
    GET DIAGNOSTICS n = ROW_COUNT;
    out := out || 'anon_coord_rows=' || n || ';';
  EXCEPTION WHEN insufficient_privilege THEN out := out || 'anon_coord=rejected;'; END;
  RESET ROLE;

  -- super_admin 成功 + 重复保存相同坐标不刷新时间
  DELETE FROM public.user_roles WHERE user_id=u;
  INSERT INTO public.user_roles(user_id, role) VALUES (u, 'super_admin');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.youzan_shops SET latitude=31.2, longitude=121.4, coord_system='gcj02' WHERE id=shop;
  GET DIAGNOSTICS n = ROW_COUNT;
  out := out || 'super_admin_coord_rows=' || n || ';';
  RESET ROLE;
  ALTER TABLE public.youzan_shops DISABLE TRIGGER trg_youzan_shops_coord_touch_upd;
  UPDATE public.youzan_shops SET coord_updated_at='2000-01-01Z' WHERE id=shop;
  ALTER TABLE public.youzan_shops ENABLE TRIGGER trg_youzan_shops_coord_touch_upd;
  SET LOCAL ROLE authenticated;
  UPDATE public.youzan_shops SET latitude=31.2, longitude=121.4, coord_system='gcj02' WHERE id=shop;
  RESET ROLE;
  SELECT coord_updated_at INTO t1 FROM public.youzan_shops WHERE id=shop;
  out := out || 'same_coords_keep_time=' || (t1='2000-01-01Z') || ';';

  RAISE EXCEPTION 'rollback:%', out;
END $$;
