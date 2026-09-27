import {
  matchBrandCandidate,
  normalizeLookupText,
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

export type ProductDateMarking = {
  text: string;
  image_index: number;
  years: number[];
  kind: "manufacturing" | "copyright" | "character" | "label" | "unknown";
};

export type ProductRecognitionAttributes = {
  brand: string | null;
  maker: string | null;
  origin_region: string | null;
  origin_country: string | null;
  era: string | null;
  date_markings?: ProductDateMarking[];
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
  ip_name?: string | null;
  maker?: string | null;
  origin_region?: string | null;
  origin_country?: string | null;
  era?: string | null;
  date_markings?: unknown;
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
  ips: BrandCandidate[];
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
  ip_id: string | null;
  ip_name: string | null;
  ip_match_status: "empty" | "matched" | "review_required";
  ip_suggestions: Array<{ id: string; name: string; score: number }>;
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

function normalizeDateMarkings(raw: RawProductRecognition, imageCount?: number) {
  const input = raw.date_markings ?? raw.attributes?.date_markings;
  const strict = imageCount !== undefined || input !== undefined;
  if (!strict) {
    const legacy = cleanString(raw.attributes?.era ?? raw.era);
    const era = legacy && /^(?:heisei|era_heisei|平成|平成时代)$/i.test(legacy)
      ? "平成（1989–2019年）" : legacy;
    return { strict, era, markings: [] as ProductDateMarking[], reason: null as string | null };
  }
  const markings: ProductDateMarking[] = [];
  let invalid = input !== undefined && !Array.isArray(input);
  for (const item of (Array.isArray(input) ? input : []).slice(0, 16)) {
    const text = cleanString(item?.text);
    const index = item?.image_index;
    if (!text || text.length > 300 || /[<>\u0000-\u001f]/.test(text) ||
        !Number.isInteger(index) || index < 1 || index > (imageCount ?? 8)) {
      invalid = true;
      continue;
    }
    const comparable = text.normalize("NFKC");
    const westernYears = (comparable.match(/(?<!\d)(?:18|19|20)\d{2}(?!\d)/g) ?? []).map(Number);
    const heiseiYears = [...comparable.matchAll(/平成(元|[1-9]\d?)年/g)]
      .map((match) => match[1] === "元" ? 1 : Number(match[1]))
      .filter((year) => year <= 31).map((year) => 1988 + year);
    const years = [...new Set([...westernYears, ...heiseiYears])].sort();
    const claimed = item.years;
    const supported = years.length > 0 && years.every((year) => year <= new Date().getUTCFullYear()) &&
      Array.isArray(claimed) && claimed.length === years.length &&
      claimed.every((year: unknown) => typeof year === "number" && Number.isInteger(year) && years.includes(year)) && new Set(claimed).size === years.length;
    let kind: ProductDateMarking["kind"] = ["manufacturing", "copyright", "character", "label", "unknown"].includes(item.kind) ? item.kind : "unknown";
    // Printed copyright symbols override model guesses, never the other way around.
    if (/©|copyright|版权/i.test(comparable)) kind = "copyright";
    if (kind === "copyright" && (!/(?:©|copyright|版权)\s*(?:(?:18|19|20)\d{2}\s*[,，、/]\s*)+(?:18|19|20)\d{2}/i.test(comparable) || (comparable.match(/©|copyright|版权/gi) ?? []).length !== 1)) kind = "unknown";
    if (kind === "manufacturing" && (!/(?:生产日期|生产年月|制造日期|制造年月|製造年月|製造日|\bMFG\b|manufactured\s+(?:in|on)|date of manufacture)/i.test(comparable) || /\b(?:not|never|maybe|probably|estimated|unknown|unconfirmed)\b|不明|不详|可能|疑似|推测|[?？]/i.test(comparable))) kind = "unknown";
    if (!supported) { kind = "unknown"; invalid = true; }
    markings.push({ text, image_index: index, years, kind });
  }
  if (Array.isArray(input) && input.length > 16) invalid = true;
  const manufacture = markings.filter((mark) => mark.kind === "manufacturing");
  const candidates = manufacture.length ? manufacture : markings.filter((mark) =>
    (mark.kind === "copyright" && mark.years.length > 1) || mark.kind === "label",
  );
  const selected = candidates.map((mark) => ({
    year: mark.kind === "copyright" ? Math.max(...mark.years) : mark.years.length === 1 ? mark.years[0] : null,
    kind: mark.kind,
  }));
  const conflict = selected.some((mark) => mark.year === null) || new Set(selected.map((mark) => mark.year)).size > 1;
  if (invalid || conflict || !selected.length) return {
    strict, era: null, markings,
    reason: conflict ? "多图日期证据冲突，请核对是否为同一商品" : "没有足够明确的商品日期证据，版权或角色年份不能当作生产年份",
  };
  const label = manufacture.length ? "生产年份" : selected.some((mark) => mark.kind === "copyright") ? "版权标注" : "标签标注";
  return { strict, era: `${selected[0].year}年（${label}）`, markings, reason: null };
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

export function findSanrioBrandCandidate(
  brands: BrandCandidate[],
  ips: BrandCandidate[],
): BrandCandidate | null {
  // The existing taxonomy also stores Sanrio as a parent IP. Reuse its identity.
  for (const candidates of [brands, ips]) {
    for (const name of ["三丽鸥 (Sanrio)", "Sanrio", "三丽鸥"]) {
      const match = matchBrandCandidate(name, candidates).match;
      if (match) return match;
    }
  }
  return null;
}

export function normalizeProductRecognition(
  raw: RawProductRecognition,
  categories: CategoryNode[],
  taxonomy: ProductTaxonomyContext = { facets: [], brands: [], ips: [] },
  context?: { imageCount: number },
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
  const ip = matchBrandCandidate(raw.ip_name, taxonomy.ips);
  const sanrio = findSanrioBrandCandidate(taxonomy.brands, taxonomy.ips);
  const clarificationRequests = cleanClarificationRequests(raw.clarification_requests);
  const dates = normalizeDateMarkings(raw, context?.imageCount);
  if (dates.reason && !clarificationRequests.some((item) => item.field === "era")) {
    clarificationRequests.push({ field: "era", question: "请补拍清晰的底款、吊牌或背标日期文字", reason: dates.reason });
  }
  // Guard only explicit era/manufacture claims, not ordinary model numbers or product prose.
  const description = cleanString(raw.description);
  const descriptionParts = description?.split(/[。；;]/u) ?? [];
  const keptParts = dates.strict ? descriptionParts.filter((part) => !/(?:\bHeisei\b|平成|\d{4}年\s*(?:生产|制造|製造)|(?:生产|制造|製造)(?:于|年份|日期|年月)?[：:\s]*\d{4})/i.test(part.normalize("NFKC"))) : descriptionParts;
  const safeDescription = keptParts.length === descriptionParts.length ? description : cleanString(keptParts.filter((part) => part.trim()).join("；"));
  const productionYear = Number(dates.era?.match(/^(\d{4})年（生产年份）$/)?.[1]);
  const keepFacet = (facet: { dimension: string; code?: string }) => {
    if (!dates.strict || facet.dimension !== "era") return true;
    if (facet.code === "era_heisei") return productionYear > 1989 && productionYear < 2019;
    if (facet.code === "era_showa") return productionYear > 1926 && productionYear < 1989;
    return false;
  };
  const ipConfidence = raw.attribute_confidence?.ip_name === undefined
    ? confidence
    : cleanConfidence(raw.attribute_confidence.ip_name);
  let brandText = cleanString(nested.brand) ?? cleanString(raw.brand);
  if (
    !brandText &&
    normalizeLookupText(ip.match?.name) === "hellokitty" &&
    ipConfidence !== null && ipConfidence >= AUTO_CLASSIFY_THRESHOLD &&
    !clarificationRequests.some(({ field }) => field === "brand" || field === "ip_name")
  ) {
    brandText = sanrio?.name ?? null;
  }
  const brand = matchBrandCandidate(brandText, [
    ...taxonomy.brands,
    ...(sanrio ? [sanrio] : []),
  ]);
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
      brand: brandText,
      maker: cleanString(nested.maker ?? raw.maker),
      origin_region: cleanString(nested.origin_region ?? raw.origin_region),
      origin_country: cleanString(nested.origin_country ?? raw.origin_country),
      era: dates.era,
      ...(dates.strict ? { date_markings: dates.markings } : {}),
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
    description: safeDescription,
    keywords: cleanStringArray(raw.keywords),
    suggested_price_cny: cleanPrice(raw.suggested_price_cny),
    compliance_flags: complianceFlags,
    evidence: [...cleanStringArray(raw.evidence), ...dates.markings.map((mark) => `图${mark.image_index} 日期原文（${mark.kind}）：${mark.text}`)],
    warning: cleanString(raw.warning),
    brand_id: brand.match?.id ?? null,
    brand_candidate_text: brand.candidate_text,
    brand_match_status: brand.status,
    brand_suggestions: brand.suggestions.map((item) => ({
      id: item.brand.id,
      name: item.brand.name,
      score: Math.round(item.score * 1000) / 1000,
    })),
    ip_id: ip.match?.id ?? null,
    ip_name: ip.match?.name ?? ip.candidate_text,
    ip_match_status: ip.status,
    ip_suggestions: ip.suggestions.map((item) => ({
      id: item.brand.id,
      name: item.brand.name,
      score: Math.round(item.score * 1000) / 1000,
    })),
    facets: normalizedFacets.matches.filter(keepFacet),
    unmatched_facets: normalizedFacets.unmatched.filter(keepFacet),
    attribute_confidence: cleanConfidenceMap(raw.attribute_confidence),
    clarification_requests: clarificationRequests,
  };
}
