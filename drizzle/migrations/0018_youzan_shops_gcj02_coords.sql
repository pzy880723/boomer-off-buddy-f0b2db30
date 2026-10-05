ALTER TABLE public.youzan_shops
  ADD COLUMN IF NOT EXISTS latitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS coord_system text,
  ADD COLUMN IF NOT EXISTS coord_updated_at timestamptz;

ALTER TABLE public.youzan_shops
  ADD CONSTRAINT youzan_shops_coords_pair
  CHECK ((latitude IS NULL) = (longitude IS NULL)) NOT VALID;

ALTER TABLE public.youzan_shops
  ADD CONSTRAINT youzan_shops_coords_range
  CHECK (latitude IS NULL OR (latitude BETWEEN 3 AND 54 AND longitude BETWEEN 73 AND 136)) NOT VALID;

ALTER TABLE public.youzan_shops
  ADD CONSTRAINT youzan_shops_coord_system_gcj02
  CHECK (latitude IS NULL OR coord_system = 'gcj02') NOT VALID;

COMMENT ON COLUMN public.youzan_shops.latitude IS 'GCJ-02 纬度（火星坐标系），人工录入，禁止按地址推算';
COMMENT ON COLUMN public.youzan_shops.longitude IS 'GCJ-02 经度（火星坐标系），人工录入，禁止按地址推算';
COMMENT ON COLUMN public.youzan_shops.coord_system IS '坐标系，仅允许 gcj02；坐标为空时为 NULL';