-- 门店坐标仅 super_admin 可经数据 API 修改；其它门店字段权限不变。
-- ROLLBACK SQL:
--   DROP TRIGGER IF EXISTS trg_youzan_shops_coord_guard ON public.youzan_shops;
--   DROP FUNCTION IF EXISTS public.youzan_shops_guard_coord_admin();
CREATE OR REPLACE FUNCTION public.youzan_shops_guard_coord_admin()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $f$
DECLARE changed boolean;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    changed := NEW.latitude IS NOT NULL OR NEW.longitude IS NOT NULL OR NEW.coord_system IS NOT NULL;
  ELSE
    changed := NEW.latitude IS DISTINCT FROM OLD.latitude
            OR NEW.longitude IS DISTINCT FROM OLD.longitude
            OR NEW.coord_system IS DISTINCT FROM OLD.coord_system;
  END IF;
  IF changed AND NOT (auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION '门店坐标仅总部管理员可修改' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.youzan_shops_guard_coord_admin() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_youzan_shops_coord_guard ON public.youzan_shops;
CREATE TRIGGER trg_youzan_shops_coord_guard
  BEFORE INSERT OR UPDATE OF latitude, longitude, coord_system ON public.youzan_shops
  FOR EACH ROW EXECUTE FUNCTION public.youzan_shops_guard_coord_admin();