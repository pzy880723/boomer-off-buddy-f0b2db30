
ALTER TABLE public.inv_brands DROP CONSTRAINT inv_brands_entity_type_check;
ALTER TABLE public.inv_brands ADD CONSTRAINT inv_brands_entity_type_check
  CHECK (entity_type = ANY (ARRAY['brand'::text, 'kiln'::text, 'ip'::text, 'manufacturer'::text, 'studio'::text, 'designer'::text]));

-- 合并：制造商 → 品牌
UPDATE public.inv_brands SET entity_type = 'brand' WHERE entity_type IN ('manufacturer','designer');
-- 工作室（动画制作公司）→ IP
UPDATE public.inv_brands SET entity_type = 'ip' WHERE entity_type = 'studio';

-- 显著属于动漫 / IP 的品牌批量归入 IP
UPDATE public.inv_brands SET entity_type = 'ip'
WHERE entity_type = 'brand' AND name = ANY (ARRAY[
  '吉卜力周边 (Benelic)',
  '宝可梦公司 (The Pokémon Company)',
  '迪士尼 (Disney)',
  '漫威 (Marvel)',
  'DC 漫画 (DC Comics)',
  '变形金刚 (Transformers)',
  '卡通频道 (Cartoon Network)',
  '三丽鸥 (Sanrio)',
  'LINE FRIENDS',
  'San-X',
  'Rovio',
  '森贝儿家族 (Sylvanian Families)',
  '魂之限定 (Tamashii Nations)',
  'Aniplex',
  'Bushiroad',
  'Cospa',
  'Movic',
  '小学馆 (Shogakukan)',
  '角川 (Kadokawa)',
  '讲谈社 (Kodansha)',
  '集英社 (Shueisha)'
]);
