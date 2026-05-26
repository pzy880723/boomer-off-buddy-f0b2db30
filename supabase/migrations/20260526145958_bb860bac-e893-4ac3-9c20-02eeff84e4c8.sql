
-- 1. 加字段
ALTER TABLE public.japan_parcels
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS system_code text;

ALTER TABLE public.japan_parcel_items
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS system_code text;

-- 2. 回填历史数据（按 created_at 升序，按 Asia/Shanghai 当天分组）
WITH ranked AS (
  SELECT id,
         'P-' || to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD') AS prefix,
         row_number() OVER (
           PARTITION BY to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')
           ORDER BY created_at, id
         ) AS rn
  FROM public.japan_parcels
  WHERE system_code IS NULL
)
UPDATE public.japan_parcels p
   SET system_code = r.prefix || '-' || lpad(r.rn::text, 4, '0')
  FROM ranked r WHERE r.id = p.id;

WITH ranked AS (
  SELECT id,
         'I-' || to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD') AS prefix,
         row_number() OVER (
           PARTITION BY to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYYMMDD')
           ORDER BY created_at, id
         ) AS rn
  FROM public.japan_parcel_items
  WHERE system_code IS NULL
)
UPDATE public.japan_parcel_items i
   SET system_code = r.prefix || '-' || lpad(r.rn::text, 4, '0')
  FROM ranked r WHERE r.id = i.id;

-- 3. 唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS japan_parcels_system_code_key
  ON public.japan_parcels(system_code);
CREATE UNIQUE INDEX IF NOT EXISTS japan_parcel_items_system_code_key
  ON public.japan_parcel_items(system_code);

-- 4. 触发器函数 + 触发器
CREATE OR REPLACE FUNCTION public.tg_japan_parcels_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prefix text;
  n int;
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  IF NEW.system_code IS NULL OR NEW.system_code = '' THEN
    prefix := 'P-' || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD');
    SELECT COALESCE(MAX((regexp_match(system_code, '(\d+)$'))[1]::int), 0) + 1
      INTO n
      FROM public.japan_parcels
     WHERE system_code LIKE prefix || '-%';
    NEW.system_code := prefix || '-' || lpad(n::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_japan_parcel_items_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prefix text;
  n int;
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  IF NEW.system_code IS NULL OR NEW.system_code = '' THEN
    prefix := 'I-' || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD');
    SELECT COALESCE(MAX((regexp_match(system_code, '(\d+)$'))[1]::int), 0) + 1
      INTO n
      FROM public.japan_parcel_items
     WHERE system_code LIKE prefix || '-%';
    NEW.system_code := prefix || '-' || lpad(n::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS japan_parcels_defaults ON public.japan_parcels;
CREATE TRIGGER japan_parcels_defaults
  BEFORE INSERT ON public.japan_parcels
  FOR EACH ROW EXECUTE FUNCTION public.tg_japan_parcels_defaults();

DROP TRIGGER IF EXISTS japan_parcel_items_defaults ON public.japan_parcel_items;
CREATE TRIGGER japan_parcel_items_defaults
  BEFORE INSERT ON public.japan_parcel_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_japan_parcel_items_defaults();
