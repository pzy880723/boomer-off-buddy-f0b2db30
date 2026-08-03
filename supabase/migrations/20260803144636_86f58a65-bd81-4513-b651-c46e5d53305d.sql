UPDATE public.inv_skus s
SET category = 'ai_low_confidence',
    classification_status = 'fallback',
    category_confidence = NULL,
    updated_at = now()
WHERE s.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM public.inv_categories c
    WHERE c.code = s.category AND c.is_active = true
  );