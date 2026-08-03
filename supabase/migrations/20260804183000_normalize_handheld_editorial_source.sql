UPDATE public.editorial_contents
SET source = jsonb_build_object(
  'id', 'boomer-handheld-ai',
  'name', 'BOOMER OFF 编辑部',
  'kind', 'boomer_store',
  'label', '中古买手推荐',
  'original_url', NULL,
  'ai_summarized', true,
  'generator', coalesce(source->>'generator', 'handheld.content.generate-from-sku'),
  'model', source->>'model',
  'sku_id', source->>'sku_id'
), updated_at = now()
WHERE source->>'generator' = 'handheld.content.generate-from-sku'
  AND (
    source->>'id' IS NULL
    OR source->>'kind' IS NULL
    OR source->>'ai_summarized' IS NULL
  );
