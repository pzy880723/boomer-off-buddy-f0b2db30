ALTER TABLE public.youzan_shops DROP CONSTRAINT IF EXISTS youzan_shops_coord_system_gcj02;
ALTER TABLE public.youzan_shops
  ADD CONSTRAINT youzan_shops_coord_system_gcj02
  CHECK (
    (latitude IS NULL AND longitude IS NULL AND coord_system IS NULL)
    OR (latitude IS NOT NULL AND longitude IS NOT NULL AND coord_system IS NOT NULL AND coord_system = 'gcj02')
  ) NOT VALID;

ALTER TABLE public.youzan_shops VALIDATE CONSTRAINT youzan_shops_coords_pair;
ALTER TABLE public.youzan_shops VALIDATE CONSTRAINT youzan_shops_coords_range;
ALTER TABLE public.youzan_shops VALIDATE CONSTRAINT youzan_shops_coord_system_gcj02;

CREATE OR REPLACE FUNCTION public.youzan_shops_touch_coord_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.coord_updated_at := CASE WHEN NEW.latitude IS NULL AND NEW.longitude IS NULL AND NEW.coord_system IS NULL
                                 THEN NULL ELSE now() END;
  ELSIF NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.coord_system IS DISTINCT FROM OLD.coord_system THEN
    NEW.coord_updated_at := now();
  ELSE
    NEW.coord_updated_at := OLD.coord_updated_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.youzan_shops_touch_coord_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_youzan_shops_coord_touch_ins ON public.youzan_shops;
CREATE TRIGGER trg_youzan_shops_coord_touch_ins
  BEFORE INSERT ON public.youzan_shops
  FOR EACH ROW EXECUTE FUNCTION public.youzan_shops_touch_coord_updated_at();

DROP TRIGGER IF EXISTS trg_youzan_shops_coord_touch_upd ON public.youzan_shops;
CREATE TRIGGER trg_youzan_shops_coord_touch_upd
  BEFORE UPDATE OF latitude, longitude, coord_system, coord_updated_at ON public.youzan_shops
  FOR EACH ROW EXECUTE FUNCTION public.youzan_shops_touch_coord_updated_at();