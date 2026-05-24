ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS grade text NULL;

-- 校验值范围（允许 NULL）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inv_skus_grade_check'
  ) THEN
    ALTER TABLE public.inv_skus
      ADD CONSTRAINT inv_skus_grade_check
      CHECK (grade IS NULL OR grade IN ('N','S','A','B','C','J'));
  END IF;
END $$;

COMMENT ON COLUMN public.inv_skus.grade IS '商品评级：N 全新未拆 / S 拆封功能完好无瑕 / A 轻微痕迹 / B 明显痕迹 / C 严重瑕疵但能用 / J 当垃圾处理';