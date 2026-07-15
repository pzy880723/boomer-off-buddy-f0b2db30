import {
  matchBrandCandidate,
  normalizeFacetPredictions,
  type BrandCandidate,
  type FacetPrediction,
  type FacetTerm,
  type NormalizedFacetMatch,
} from "./product-taxonomy";

export type CategoryNode = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  is_active: boolean;
};

export type ProductRecognitionAttributes = {
  brand: string | null;
  maker: string | null;
  origin_region: string | null;
  origin_country: string | null;
  era: string | null;
  material: string[];
  craft: string[];
  object_type: string | null;
  colors: string[];
  dimensions: Record<string, string | number | boolean | null> | null;
  functional_status: string | null;
  missing_parts: string[];
};

export type RawProductRecognition = {
  category_code?: string | null;
  confidence?: number | null;
  alternative_categories?: Array<{
    category_code?: string | null;
    confidence?: number | null;
    reason?: string | null;
  }> | null;
  name?: string | null;
  attributes?: Partial<ProductRecognitionAttributes> | null;
  brand?: string | null;
  maker?: string | null;
  origin_region?: string | null;
  origin_country?: string | null;
  era?: string | null;
  material?: string[] | string | null;
  craft?: string[] | string | null;
  object_type?: string | null;
  colors?: string[] | string | null;
  dimensions?: Record<string, string | number | boolean | null> | null;
  condition_grade?: string | null;
  functional_status?: string | null;
  missing_parts?: string[] | string | null;
  description?: string | null;
  keywords?: string[] | string | null;
  suggested_price_cny?: number | null;
  compliance_flags?: string[] | string | null;
  evidence?: string[] | string | null;
  warning?: string | null;
  facet_predictions?: FacetPrediction[] | null;
  attribute_confidence?: Record<string, number | null> | null;
  clarification_requests?: Array<{
    field?: string | null;
    question?: string | null;
    reason?: string | null;
  }> | null;
};

export type ProductTaxonomyContext = {
  facets: FacetTerm[];
  brands: BrandCandidate[];
};

export type NormalizedProductRecognition = {
  category_code: string;
  predicted_category_code: string | null;
  confidence: number | null;
  status: "auto_classified" | "fallback";
  alternative_categories: Array<{
    category_code: string;
    confidence: number | null;
    reason: string | null;
  }>;
  name: string;
  attributes: ProductRecognitionAttributes;
  condition_grade: "N" | "S" | "A" | "B" | "C" | "J" | null;
  description: string | null;
  keywords: string[];
  suggested_price_cny: number | null;
  compliance_flags: string[];
  evidence: string[];
  warning: string | null;
  brand_id: string | null;
  brand_candidate_text: string | null;
  brand_match_status: "empty" | "matched" | "review_required";
  brand_suggestions: Array<{ id: string; name: string; score: number }>;
  facets: NormalizedFacetMatch[];
  unmatched_facets: FacetPrediction[];
  attribute_confidence: Record<string, number>;
  clarification_requests: Array<{
    field: string;
    question: string;
    reason: string | null;
  }>;
};

const FALLBACK_LOW_CONFIDENCE = "ai_low_confidence";
const FALLBACK_COMPLIANCE = "compliance_review";
const FALLBACK_PORCELAIN_CODES = ["porcelain_other", "porcelain_origin_unknown"];
const AUTO_CLASSIFY_THRESHOLD = 0.75;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function cleanStringArray(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(source.map(cleanString).filter((item): item is string => !!item))];
}

function cleanConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function cleanPrice(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function cleanGrade(value: unknown): "N" | "S" | "A" | "B" | "C" | "J" | null {
  return ["N", "S", "A", "B", "C", "J"].includes(String(value))
    ? (String(value) as "N" | "S" | "A" | "B" | "C" | "J")
    : null;
}

function cleanConfidenceMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanKey = cleanString(key);
    const confidence = cleanConfidence(raw);
    if (cleanKey && confidence !== null) output[cleanKey] = confidence;
  }
  return output;
}

function cleanClarificationRequests(
  value: RawProductRecognition["clarification_requests"],
): NormalizedProductRecognition["clarification_requests"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const field = cleanString(item?.field);
      const question = cleanString(item?.question);
      if (!field || !question) return null;
      return { field, question, reason: cleanString(item?.reason) };
    })
    .filter((item): item is NonNullable<typeof item> => !!item)
    .slice(0, 8);
}

export function activeLeafCategories(categories: CategoryNode[]): CategoryNode[] {
  const activeRoots = new Set(
    categories.filter((row) => row.is_active && row.parent_id === null).map((row) => row.id),
  );
  return categories.filter(
    (row) => row.is_active && row.parent_id !== null && activeRoots.has(row.parent_id),
  );
}

export function formatTaxonomyForPrompt(categories: CategoryNode[]): string {
  const parents = new Map(
    categories.filter((row) => row.is_active && row.parent_id === null).map((row) => [row.id, row]),
  );
  return activeLeafCategories(categories)
    .map((row) => `${row.code} | ${parents.get(row.parent_id!)?.name ?? "未知"} > ${row.name}`)
    .join("\n");
}

function isPorcelain(raw: RawProductRecognition, predictedCode: string | null): boolean {
  if (predictedCode?.startsWith("porcelain_")) return true;
  const nested = raw.attributes ?? {};
  const materials = cleanStringArray(nested.material ?? raw.material);
  const objectType = cleanString(nested.object_type ?? raw.object_type) ?? "";
  const name = cleanString(raw.name) ?? "";
  return (
    materials.some((value) => /瓷|骨瓷|陶瓷/u.test(value)) ||
    /瓷器|骨瓷|陶瓷/u.test(objectType) ||
    /瓷器|骨瓷/u.test(name)
  );
}

export function normalizeProductRecognition(
  raw: RawProductRecognition,
  categories: CategoryNode[],
  taxonomy: ProductTaxonomyContext = { facets: [], brands: [] },
): NormalizedProductRecognition {
  const leaves = activeLeafCategories(categories);
  if (leaves.length === 0) throw new Error("ERP 分类树没有启用的二级分类");

  const leafCodes = new Set(leaves.map((row) => row.code));
  const rawCode = cleanString(raw.category_code);
  const predictedCode = rawCode && leafCodes.has(rawCode) ? rawCode : null;
  const confidence = cleanConfidence(raw.confidence);
  const complianceFlags = cleanStringArray(raw.compliance_flags);

  const requireFallback = (code: string): string => {
    if (!leafCodes.has(code)) throw new Error(`ERP 分类树缺少系统兜底分类：${code}`);
    return code;
  };

  const requireFirstFallback = (codes: string[]): string => {
    const code = codes.find((candidate) => leafCodes.has(candidate));
    if (!code) throw new Error(`ERP 分类树缺少系统兜底分类：${codes.join(" / ")}`);
    return code;
  };

  let categoryCode: string;
  let status: "auto_classified" | "fallback" = "fallback";
  if (complianceFlags.length > 0) {
    categoryCode = requireFallback(FALLBACK_COMPLIANCE);
  } else if (confidence === null || confidence < AUTO_CLASSIFY_THRESHOLD) {
    categoryCode = requireFallback(FALLBACK_LOW_CONFIDENCE);
  } else if (predictedCode) {
    categoryCode = predictedCode;
    status = "auto_classified";
  } else if (isPorcelain(raw, predictedCode)) {
    categoryCode = requireFirstFallback(FALLBACK_PORCELAIN_CODES);
  } else {
    categoryCode = requireFallback(FALLBACK_LOW_CONFIDENCE);
  }

  const nested = raw.attributes ?? {};
  const normalizedFacets = normalizeFacetPredictions(raw.facet_predictions ?? [], taxonomy.facets);
  const brand = matchBrandCandidate(nested.brand ?? raw.brand, taxonomy.brands);
  const alternatives = (raw.alternative_categories ?? [])
    .map((item) => {
      const code = cleanString(item.category_code);
      if (!code || !leafCodes.has(code)) return null;
      return {
        category_code: code,
        confidence: cleanConfidence(item.confidence),
        reason: cleanString(item.reason),
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item)
    .slice(0, 3);

  return {
    category_code: categoryCode,
    predicted_category_code: predictedCode ?? rawCode,
    confidence,
    status,
    alternative_categories: alternatives,
    name: cleanString(raw.name) ?? "未命名中古商品",
    attributes: {
      brand: cleanString(nested.brand ?? raw.brand),
      maker: cleanString(nested.maker ?? raw.maker),
      origin_region: cleanString(nested.origin_region ?? raw.origin_region),
      origin_country: cleanString(nested.origin_country ?? raw.origin_country),
      era: cleanString(nested.era ?? raw.era),
      material: cleanStringArray(nested.material ?? raw.material),
      craft: cleanStringArray(nested.craft ?? raw.craft),
      object_type: cleanString(nested.object_type ?? raw.object_type),
      colors: cleanStringArray(nested.colors ?? raw.colors),
      dimensions:
        nested.dimensions && typeof nested.dimensions === "object"
          ? nested.dimensions
          : raw.dimensions && typeof raw.dimensions === "object"
            ? raw.dimensions
            : null,
      functional_status: cleanString(nested.functional_status ?? raw.functional_status),
      missing_parts: cleanStringArray(nested.missing_parts ?? raw.missing_parts),
    },
    condition_grade: cleanGrade(raw.condition_grade),
    description: cleanString(raw.description),
    keywords: cleanStringArray(raw.keywords),
    suggested_price_cny: cleanPrice(raw.suggested_price_cny),
    compliance_flags: complianceFlags,
    evidence: cleanStringArray(raw.evidence),
    warning: cleanString(raw.warning),
    brand_id: brand.match?.id ?? null,
    brand_candidate_text: brand.candidate_text,
    brand_match_status: brand.status,
    brand_suggestions: brand.suggestions.map((item) => ({
      id: item.brand.id,
      name: item.brand.name,
      score: Math.round(item.score * 1000) / 1000,
    })),
    facets: normalizedFacets.matches,
    unmatched_facets: normalizedFacets.unmatched,
    attribute_confidence: cleanConfidenceMap(raw.attribute_confidence),
    clarification_requests: cleanClarificationRequests(raw.clarification_requests),
  };
}
