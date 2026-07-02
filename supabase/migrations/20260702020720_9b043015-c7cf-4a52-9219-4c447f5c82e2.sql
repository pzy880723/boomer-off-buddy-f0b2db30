
ALTER TABLE public.inv_categories
  ADD COLUMN IF NOT EXISTS youzan_hq_group_id bigint,
  ADD COLUMN IF NOT EXISTS youzan_hq_group_parent_id bigint,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'group';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inv_categories_kind_check'
  ) THEN
    ALTER TABLE public.inv_categories
      ADD CONSTRAINT inv_categories_kind_check CHECK (kind IN ('group','category'));
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS inv_categories_youzan_hq_group_id_key
  ON public.inv_categories (youzan_hq_group_id)
  WHERE youzan_hq_group_id IS NOT NULL;

-- 已同步过的官方类目降级封存
UPDATE public.inv_categories
   SET kind = 'category', is_active = false
 WHERE youzan_hq_category_id IS NOT NULL
   AND kind = 'group';
