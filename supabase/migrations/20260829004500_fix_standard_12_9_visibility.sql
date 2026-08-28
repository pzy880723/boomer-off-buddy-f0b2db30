-- Keep the new 12.9 tier in the same lifecycle state as its standard product group.
-- This also repairs databases where the additive migration ran before lifecycle cloning was added.

WITH templates AS (
  SELECT DISTINCT ON (sku.category, sku.name)
    sku.category,
    sku.name,
    sku.status,
    sku.is_display
  FROM public.inv_skus sku
  WHERE sku.kind = 'single'
    AND sku.is_custom_price = false
    AND sku.inventory_policy = 'unlimited'
    AND sku.price_tier <> 12.9
  ORDER BY
    sku.category,
    sku.name,
    CASE WHEN sku.price_tier = 9.9 THEN 0 ELSE 1 END,
    sku.price_tier
)
UPDATE public.inv_skus target
SET
  status = template.status,
  is_display = template.is_display,
  updated_at = now()
FROM templates template
WHERE target.category = template.category
  AND target.name = template.name
  AND target.kind = 'single'
  AND target.is_custom_price = false
  AND target.inventory_policy = 'unlimited'
  AND target.price_tier = 12.9
  AND (
    target.status IS DISTINCT FROM template.status
    OR target.is_display IS DISTINCT FROM template.is_display
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.inv_skus target
    JOIN public.inv_skus template
      ON template.category = target.category
      AND template.name = target.name
      AND template.price_tier = 9.9
      AND template.kind = 'single'
      AND template.is_custom_price = false
      AND template.inventory_policy = 'unlimited'
    WHERE target.kind = 'single'
      AND target.is_custom_price = false
      AND target.inventory_policy = 'unlimited'
      AND target.price_tier = 12.9
      AND (
        target.status IS DISTINCT FROM template.status
        OR target.is_display IS DISTINCT FROM template.is_display
      )
  ) THEN
    RAISE EXCEPTION 'Every 12.9 standard SKU must inherit its group lifecycle state';
  END IF;
END $$;
