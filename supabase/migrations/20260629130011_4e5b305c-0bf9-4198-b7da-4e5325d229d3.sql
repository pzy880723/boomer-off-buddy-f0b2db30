ALTER TABLE public.inv_skus ADD COLUMN IF NOT EXISTS image_paths text[] NOT NULL DEFAULT '{}';

-- 回填：把 http(s) 外链 image_url 放进 image_paths（signed URL 不要，会过期）
UPDATE public.inv_skus
SET image_paths = ARRAY[image_url]
WHERE image_paths = '{}'
  AND image_url IS NOT NULL
  AND image_url ~ '^https?://'
  AND image_url NOT LIKE '%token=%';
