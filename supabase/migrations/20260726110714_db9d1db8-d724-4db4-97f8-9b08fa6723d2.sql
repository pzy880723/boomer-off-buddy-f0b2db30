CREATE OR REPLACE FUNCTION public.search_inv_skus(
  p_query text DEFAULT NULL::text,
  p_primary_category text DEFAULT NULL::text,
  p_brand_ids uuid[] DEFAULT NULL::uuid[],
  p_facet_codes text[] DEFAULT NULL::text[],
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(sku_id uuid, search_rank real)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $function$
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
        extensions.similarity(d.document, lower(trim(p_query))),
        extensions.similarity(lower(s.name), lower(trim(p_query)))
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
      OR extensions.similarity(d.document, lower(trim(p_query))) >= 0.16
      OR extensions.similarity(lower(s.name), lower(trim(p_query))) >= 0.22
    )
  ORDER BY search_rank DESC, s.created_at DESC
  LIMIT least(greatest(p_limit, 1), 500)
  OFFSET greatest(p_offset, 0);
$function$;