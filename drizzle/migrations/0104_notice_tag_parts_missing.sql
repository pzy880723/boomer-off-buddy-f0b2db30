-- 新增提示标签 parts_missing（零件缺失）；保留功能不确定/不可用互斥与字典顺序。只替换校验/规范化函数，不改任何商品数据。
CREATE OR REPLACE FUNCTION public.inv_notice_tags_valid(p text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT p IS NOT NULL
     AND p <@ ARRAY['flawed','function_uncertain','function_unavailable','not_edible','parts_missing']::text[]
     AND cardinality(p) = (SELECT count(DISTINCT x) FROM unnest(p) x)
     AND NOT (p @> ARRAY['function_uncertain','function_unavailable']::text[])
$$;
CREATE OR REPLACE FUNCTION public.inv_notice_tags_normalize(p text[])
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(array_agg(t ORDER BY o), '{}'::text[])
    FROM unnest(ARRAY['flawed','function_uncertain','function_unavailable','not_edible','parts_missing']::text[]) WITH ORDINALITY AS d(t, o)
   WHERE t = ANY(p)
$$;
COMMENT ON COLUMN public.inv_skus.notice_tags IS '提示标签（多选，可空）：flawed 有瑕疵 / function_uncertain 功能不确定 / function_unavailable 功能不可用 / not_edible 不可食用 / parts_missing 零件缺失；功能不确定与不可用互斥';
