-- Keep Sanrio as the parent IP company while matching Hello Kitty as a specific character.
UPDATE public.inv_brands
SET aliases = array_remove(
  array_remove(
    array_remove(COALESCE(aliases, ARRAY[]::text[]), 'Hello Kitty'),
    'HelloKitty'
  ),
  '凯蒂猫'
),
updated_at = now()
WHERE entity_type = 'ip'
  AND (name = '三丽鸥 (Sanrio)' OR normalized_name = 'sanrio');

INSERT INTO public.inv_brands (
  name,
  name_original,
  normalized_name,
  aliases,
  entity_type,
  origin_country,
  notes,
  status,
  created_at,
  updated_at
)
VALUES (
  'Hello Kitty',
  'ハローキティ',
  'hello kitty',
  ARRAY['HelloKitty', 'Kitty', '凯蒂猫', 'ハローキティ'],
  'ip',
  '日本',
  '三丽鸥旗下具体角色；识别时优先于母品牌三丽鸥',
  'active',
  now(),
  now()
)
ON CONFLICT (normalized_name) DO UPDATE SET
  name = EXCLUDED.name,
  name_original = EXCLUDED.name_original,
  aliases = EXCLUDED.aliases,
  entity_type = 'ip',
  origin_country = EXCLUDED.origin_country,
  notes = EXCLUDED.notes,
  status = 'active',
  updated_at = now();
