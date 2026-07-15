-- BOOMER-OFF compound product taxonomy.
-- One primary category remains on inv_skus.category for ERP compatibility;
-- brands and multi-dimensional facets are normalized relations.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.inv_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_original text,
  normalized_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  entity_type text NOT NULL DEFAULT 'brand'
    CHECK (entity_type IN ('brand', 'manufacturer', 'kiln', 'studio', 'designer')),
  origin_country text,
  origin_region text,
  category_codes text[] NOT NULL DEFAULT '{}',
  logo_url text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'review')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalized_name)
);

CREATE TABLE IF NOT EXISTS public.inv_facets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  dimension text NOT NULL
    CHECK (dimension IN (
      'object_type', 'function', 'origin', 'material', 'era', 'craft',
      'style', 'ip', 'character', 'series', 'release_method'
    )),
  parent_id uuid REFERENCES public.inv_facets(id) ON DELETE SET NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  category_codes text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dimension, name)
);

CREATE TABLE IF NOT EXISTS public.inv_sku_facets (
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  facet_id uuid NOT NULL REFERENCES public.inv_facets(id) ON DELETE RESTRICT,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'ai', 'migration', 'import')),
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (sku_id, facet_id)
);

ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.inv_brands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS brand_candidate_text text,
  ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS attribute_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS clarification_requests jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.inv_sku_classifications
  ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.inv_brands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS brand_candidate_text text,
  ADD COLUMN IF NOT EXISTS facet_predictions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS unmatched_facets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attribute_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS clarification_requests jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_inv_brands_name_trgm
  ON public.inv_brands USING gin (normalized_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inv_brands_aliases ON public.inv_brands USING gin (aliases);
CREATE INDEX IF NOT EXISTS idx_inv_facets_dimension_active
  ON public.inv_facets(dimension, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_inv_facets_name_trgm
  ON public.inv_facets USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inv_sku_facets_facet ON public.inv_sku_facets(facet_id, sku_id);
CREATE INDEX IF NOT EXISTS idx_inv_skus_brand ON public.inv_skus(brand_id);
CREATE INDEX IF NOT EXISTS idx_inv_skus_keywords ON public.inv_skus USING gin (keywords);

WITH rows(name, name_original, normalized_name, aliases, entity_type, origin_country) AS (
  VALUES
    ('Noritake', 'ノリタケ', 'noritake', ARRAY['则武', '日本陶器会社'], 'manufacturer', '日本'),
    ('Wedgwood', NULL, 'wedgwood', ARRAY['韦奇伍德'], 'brand', '英国'),
    ('SONY', 'ソニー', 'sony', ARRAY['索尼'], 'brand', '日本'),
    ('Bandai', 'バンダイ', 'bandai', ARRAY['万代'], 'brand', '日本'),
    ('Nintendo', '任天堂', 'nintendo', ARRAY['任天堂'], 'brand', '日本')
)
INSERT INTO public.inv_brands (
  name, name_original, normalized_name, aliases, entity_type, origin_country
)
SELECT name, name_original, normalized_name, aliases, entity_type, origin_country
FROM rows
ON CONFLICT (normalized_name) DO UPDATE SET
  name = EXCLUDED.name,
  name_original = EXCLUDED.name_original,
  aliases = EXCLUDED.aliases,
  entity_type = EXCLUDED.entity_type,
  origin_country = EXCLUDED.origin_country,
  updated_at = now();

WITH rows(code, name, dimension, aliases, category_codes, sort_order) AS (
  VALUES
    ('object_coffee_cup', '咖啡杯', 'object_type', ARRAY['咖啡杯碟'], ARRAY['porcelain_drinkware'], 10),
    ('object_teacup', '茶杯', 'object_type', ARRAY['茶杯碟'], ARRAY['porcelain_drinkware'], 20),
    ('object_mug', '马克杯', 'object_type', ARRAY['大杯'], ARRAY['porcelain_drinkware'], 30),
    ('object_badge', '徽章/吧唧', 'object_type', ARRAY['徽章', '吧唧', '胸章'], ARRAY['character_badge'], 40),
    ('function_drinking', '饮用', 'function', ARRAY['饮茶', '咖啡'], ARRAY['porcelain_drinkware'], 10),
    ('function_display', '陈列', 'function', ARRAY['摆件', '装饰'], ARRAY['porcelain_decor_figurine'], 20),
    ('origin_japan', '日本', 'origin', ARRAY['Japan', '日本制'], ARRAY[]::text[], 10),
    ('origin_china', '中国', 'origin', ARRAY['China', '中国制'], ARRAY[]::text[], 20),
    ('origin_europe', '欧洲', 'origin', ARRAY['Europe', '欧州'], ARRAY[]::text[], 30),
    ('origin_uk', '英国', 'origin', ARRAY['UK', 'England', '英国制'], ARRAY[]::text[], 40),
    ('material_porcelain', '瓷器', 'material', ARRAY['瓷', '陶瓷'], ARRAY['porcelain'], 10),
    ('material_bone_china', '骨瓷', 'material', ARRAY['Bone China'], ARRAY['porcelain'], 20),
    ('material_metal', '金属', 'material', ARRAY['铁', '铜', '合金'], ARRAY[]::text[], 30),
    ('era_showa', '昭和', 'era', ARRAY['昭和时代', 'Showa'], ARRAY[]::text[], 10),
    ('era_heisei', '平成', 'era', ARRAY['平成时代', 'Heisei'], ARRAY[]::text[], 20),
    ('craft_gilt', '描金', 'craft', ARRAY['金彩'], ARRAY['porcelain'], 10),
    ('craft_hand_painted', '手绘', 'craft', ARRAY['手描', '手描き'], ARRAY[]::text[], 20),
    ('style_retro', '复古', 'style', ARRAY['Vintage'], ARRAY[]::text[], 10),
    ('ip_pokemon', '宝可梦', 'ip', ARRAY['Pokemon', 'Pokémon', '口袋妖怪'], ARRAY[]::text[], 10),
    ('character_pikachu', '皮卡丘', 'character', ARRAY['Pikachu'], ARRAY[]::text[], 10),
    ('series_noritake_occupation', 'Noritake 职业系列', 'series', ARRAY['职业系列'], ARRAY[]::text[], 10),
    ('release_limited', '限定', 'release_method', ARRAY['限量', '会场限定', '店铺限定'], ARRAY[]::text[], 10),
    ('release_prize', '景品', 'release_method', ARRAY['一番赏', '奖品'], ARRAY[]::text[], 20)
)
INSERT INTO public.inv_facets (
  code, name, dimension, aliases, category_codes, sort_order, is_system
)
SELECT code, name, dimension, aliases, category_codes, sort_order, true
FROM rows
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  dimension = EXCLUDED.dimension,
  aliases = EXCLUDED.aliases,
  category_codes = EXCLUDED.category_codes,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  is_system = true,
  updated_at = now();

WITH roots(code, name, sort_order) AS (
  VALUES ('character_ip_goods', '角色与IP杂货', 35)
)
INSERT INTO public.inv_categories(code, name, parent_id, sort_order, is_active, is_system, kind)
SELECT code, name, NULL, sort_order, true, true, 'category' FROM roots
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = true, updated_at = now();

WITH children(code, name, parent_code, sort_order) AS (
  VALUES
    ('porcelain_drinkware', '杯具与饮用器', 'porcelain', 11),
    ('porcelain_tableware', '盘碗与餐具', 'porcelain', 12),
    ('porcelain_serveware', '壶罐与盛装器', 'porcelain', 13),
    ('porcelain_vase_planter', '花器与盆器', 'porcelain', 14),
    ('porcelain_decor_figurine', '摆件与人偶', 'porcelain', 15),
    ('porcelain_other', '其他陶瓷物件', 'porcelain', 18),
    ('character_badge', '徽章/吧唧', 'character_ip_goods', 351),
    ('character_acrylic', '亚克力杂货', 'character_ip_goods', 352),
    ('character_paper', '纸品/卡片', 'character_ip_goods', 353),
    ('character_plush', '毛绒/布艺', 'character_ip_goods', 354),
    ('character_other', '其他IP杂货', 'character_ip_goods', 359)
)
INSERT INTO public.inv_categories(code, name, parent_id, sort_order, is_active, is_system, kind)
SELECT c.code, c.name, p.id, c.sort_order, true, true, 'category'
FROM children c
JOIN public.inv_categories p ON p.code = c.parent_code
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  parent_id = EXCLUDED.parent_id,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  is_system = true,
  updated_at = now();

-- Preserve the old porcelain origin classification as an origin facet before
-- moving those SKUs to object-based primary categories.
INSERT INTO public.inv_sku_facets(sku_id, facet_id, source, confidence)
SELECT s.id, f.id, 'migration', 1
FROM public.inv_skus s
JOIN public.inv_facets f ON f.code = CASE s.category
  WHEN 'porcelain_japan' THEN 'origin_japan'
  WHEN 'porcelain_china' THEN 'origin_china'
  WHEN 'porcelain_europe' THEN 'origin_europe'
  ELSE NULL
END
WHERE s.category IN ('porcelain_japan', 'porcelain_china', 'porcelain_europe')
ON CONFLICT (sku_id, facet_id) DO NOTHING;

UPDATE public.inv_skus
SET category = CASE
  WHEN lower(coalesce(attributes->>'object_type', name, '')) ~ '(杯|cup|mug)' THEN 'porcelain_drinkware'
  WHEN lower(coalesce(attributes->>'object_type', name, '')) ~ '(盘|碗|plate|bowl)' THEN 'porcelain_tableware'
  WHEN lower(coalesce(attributes->>'object_type', name, '')) ~ '(壶|罐|pot|jar)' THEN 'porcelain_serveware'
  WHEN lower(coalesce(attributes->>'object_type', name, '')) ~ '(花瓶|花器|盆|vase)' THEN 'porcelain_vase_planter'
  WHEN lower(coalesce(attributes->>'object_type', name, '')) ~ '(摆件|人偶|figurine)' THEN 'porcelain_decor_figurine'
  ELSE 'porcelain_other'
END
WHERE category IN (
  'porcelain_japan', 'porcelain_europe', 'porcelain_china',
  'porcelain_asia_other', 'porcelain_other_region', 'porcelain_origin_unknown'
);

UPDATE public.inv_categories
SET is_active = false, updated_at = now()
WHERE code IN (
  'porcelain_japan', 'porcelain_europe', 'porcelain_china',
  'porcelain_asia_other', 'porcelain_other_region', 'porcelain_origin_unknown'
);

CREATE OR REPLACE FUNCTION public.search_inv_skus(
  p_query text DEFAULT NULL,
  p_primary_category text DEFAULT NULL,
  p_brand_ids uuid[] DEFAULT NULL,
  p_facet_codes text[] DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(sku_id uuid, search_rank real)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH selected_facets AS (
    SELECT DISTINCT f.dimension, f.code
    FROM public.inv_facets f
    WHERE f.code = ANY(coalesce(p_facet_codes, ARRAY[]::text[]))
  ),
  dimension_totals AS (
    SELECT count(DISTINCT dimension)::integer AS selected_dimensions
    FROM selected_facets
  ),
  sku_facet_matches AS (
    SELECT sf.sku_id, count(DISTINCT f.dimension)::integer AS matched_dimensions
    FROM public.inv_sku_facets sf
    JOIN public.inv_facets f ON f.id = sf.facet_id
    JOIN selected_facets wanted ON wanted.dimension = f.dimension AND wanted.code = f.code
    GROUP BY sf.sku_id
  ),
  documents AS (
    SELECT
      s.id,
      lower(concat_ws(' ',
        s.name,
        s.sku_code,
        s.epc,
        s.notes,
        array_to_string(s.keywords, ' '),
        c.name,
        b.name,
        b.name_original,
        brand_aliases.value,
        facet_terms.value
      )) AS document
    FROM public.inv_skus s
    LEFT JOIN public.inv_categories c ON c.code = s.category
    LEFT JOIN public.inv_brands b ON b.id = s.brand_id
    LEFT JOIN LATERAL (
      SELECT string_agg(alias, ' ') AS value FROM unnest(b.aliases) alias
    ) brand_aliases ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(concat_ws(' ', f.name, array_to_string(f.aliases, ' ')), ' ') AS value
      FROM public.inv_sku_facets sf
      JOIN public.inv_facets f ON f.id = sf.facet_id
      WHERE sf.sku_id = s.id
    ) facet_terms ON true
  )
  SELECT
    s.id AS sku_id,
    CASE
      WHEN nullif(trim(coalesce(p_query, '')), '') IS NULL THEN 1::real
      ELSE greatest(
        similarity(d.document, lower(trim(p_query))),
        similarity(lower(s.name), lower(trim(p_query)))
      )::real
    END AS search_rank
  FROM public.inv_skus s
  JOIN documents d ON d.id = s.id
  CROSS JOIN dimension_totals dt
  LEFT JOIN sku_facet_matches sm ON sm.sku_id = s.id
  WHERE (
      p_primary_category IS NULL
      OR s.category = p_primary_category
      OR EXISTS (
        SELECT 1
        FROM public.inv_categories child
        JOIN public.inv_categories parent ON parent.id = child.parent_id
        WHERE child.code = s.category
          AND parent.code = p_primary_category
      )
    )
    AND (coalesce(cardinality(p_brand_ids), 0) = 0 OR s.brand_id = ANY(p_brand_ids))
    AND (dt.selected_dimensions = 0 OR sm.matched_dimensions = dt.selected_dimensions)
    AND (
      nullif(trim(coalesce(p_query, '')), '') IS NULL
      OR d.document ILIKE '%' || trim(p_query) || '%'
      OR similarity(d.document, lower(trim(p_query))) >= 0.16
      OR similarity(lower(s.name), lower(trim(p_query))) >= 0.22
    )
  ORDER BY search_rank DESC, s.created_at DESC
  LIMIT least(greatest(p_limit, 1), 500)
  OFFSET greatest(p_offset, 0);
$$;

ALTER TABLE public.inv_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_facets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_sku_facets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_brands' AND policyname = 'inv_brands_authenticated') THEN
    CREATE POLICY inv_brands_authenticated ON public.inv_brands FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_facets' AND policyname = 'inv_facets_authenticated') THEN
    CREATE POLICY inv_facets_authenticated ON public.inv_facets FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_sku_facets' AND policyname = 'inv_sku_facets_authenticated') THEN
    CREATE POLICY inv_sku_facets_authenticated ON public.inv_sku_facets FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_brands TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_facets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_sku_facets TO authenticated;
GRANT ALL ON public.inv_brands, public.inv_facets, public.inv_sku_facets TO service_role;
GRANT EXECUTE ON FUNCTION public.search_inv_skus(text, text, uuid[], text[], integer, integer)
  TO authenticated, service_role;
