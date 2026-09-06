import {
  activeLeafCategories,
  formatTaxonomyForPrompt,
  normalizeProductRecognition,
  type CategoryNode,
  type NormalizedProductRecognition,
  type RawProductRecognition,
} from "../lib/product-classification";
import type { BrandCandidate, FacetTerm } from "../lib/product-taxonomy";

export const PRODUCT_RECOGNITION_PROMPT_VERSION = "boomer-product-v3-fast-handheld";
export const DEFAULT_PRODUCT_RECOGNITION_MODEL = "google/gemini-2.5-pro";
export const DEFAULT_HANDHELD_RECOGNITION_MODEL = "google/gemini-2.5-flash";

export type ProductRecognitionSource = "erp" | "handheld" | "migration";

export type ProductRecognitionInput = {
  images: string[];
  source: ProductRecognitionSource;
  hint?: string | null;
  created_by?: string | null;
};

export type ProductRecognitionAuditInput = {
  source: ProductRecognitionSource;
  image_count: number;
  category_code: string;
  predicted_category_code: string | null;
  confidence: number | null;
  alternative_categories: NormalizedProductRecognition["alternative_categories"];
  attributes: NormalizedProductRecognition["attributes"];
  evidence: string[];
  raw_result: RawProductRecognition | Record<string, unknown>;
  normalized_result: NormalizedProductRecognition;
  model: string;
  prompt_version: string;
  taxonomy_version: string;
  status: "completed" | "fallback" | "failed";
  warning: string | null;
  brand_id: string | null;
  brand_candidate_text: string | null;
  ip_id: string | null;
  ip_candidate_text: string | null;
  facet_predictions: NormalizedProductRecognition["facets"];
  unmatched_facets: NormalizedProductRecognition["unmatched_facets"];
  attribute_confidence: NormalizedProductRecognition["attribute_confidence"];
  clarification_requests: NormalizedProductRecognition["clarification_requests"];
  created_by?: string | null;
};

export type ProductRecognitionDeps = {
  loadCategories: () => Promise<CategoryNode[]>;
  loadFacets?: () => Promise<FacetTerm[]>;
  loadBrands?: () => Promise<BrandCandidate[]>;
  loadIps?: () => Promise<BrandCandidate[]>;
  callModel: (input: {
    source: ProductRecognitionSource;
    images: string[];
    hint?: string | null;
    taxonomyPrompt: string;
    facetPrompt: string;
    brandPrompt: string;
    ipPrompt: string;
  }) => Promise<{ model: string; raw: RawProductRecognition }>;
  saveAudit: (input: ProductRecognitionAuditInput) => Promise<{ id: string }>;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type ProductRecognitionResult = NormalizedProductRecognition & {
  request_id: string;
  model: string;
  prompt_version: string;
  taxonomy_version: string;
};

function taxonomyVersion(
  categories: CategoryNode[],
  facets: FacetTerm[],
  brands: BrandCandidate[],
): string {
  const signature = [
    ...activeLeafCategories(categories).map((row) => `category:${row.code}:${row.name}`),
    ...facets.map((row) => `facet:${row.dimension}:${row.code}:${row.name}`),
    ...brands.map((row) => `brand:${row.id}:${row.name}:${row.aliases.join(",")}`),
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `taxonomy-v2-${(hash >>> 0).toString(16)}`;
}

function formatFacetsForPrompt(facets: FacetTerm[]): string {
  return facets
    .map(
      (facet) =>
        `${facet.code} | ${facet.dimension} | ${facet.name}${
          facet.aliases.length ? ` | 别名: ${facet.aliases.join("、")}` : ""
        }`,
    )
    .join("\n");
}

function formatBrandsForPrompt(brands: BrandCandidate[]): string {
  return brands
    .map(
      (brand) =>
        `${brand.id} | ${brand.name}${brand.name_original ? ` | ${brand.name_original}` : ""}${
          brand.aliases.length ? ` | 别名: ${brand.aliases.join("、")}` : ""
        }`,
    )
    .join("\n");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function auditStatus(normalized: NormalizedProductRecognition): "completed" | "fallback" {
  return normalized.status === "auto_classified" ? "completed" : "fallback";
}

export async function runProductRecognition(
  input: ProductRecognitionInput,
  deps: ProductRecognitionDeps,
): Promise<ProductRecognitionResult> {
  const images = input.images.filter(Boolean).slice(0, 8);
  if (images.length === 0) throw new Error("至少需要一张商品照片");

  const [categories, facets, brands, ips] = await Promise.all([
    deps.loadCategories(),
    deps.loadFacets?.() ?? Promise.resolve([]),
    deps.loadBrands?.() ?? Promise.resolve([]),
    deps.loadIps?.() ?? Promise.resolve([]),
  ]);
  const taxonomyPrompt = formatTaxonomyForPrompt(categories);
  if (!taxonomyPrompt) throw new Error("ERP 分类树没有可用于识别的二级分类");
  const version = taxonomyVersion(categories, facets, [...brands, ...ips]);
  const facetPrompt = formatFacetsForPrompt(facets);
  const brandPrompt = formatBrandsForPrompt(brands);
  const ipPrompt = formatBrandsForPrompt(ips);
  const wait = deps.sleep ?? sleep;

  let model = input.source === "handheld" ? DEFAULT_HANDHELD_RECOGNITION_MODEL : DEFAULT_PRODUCT_RECOGNITION_MODEL;
  let raw: RawProductRecognition | null = null;
  let lastError: Error | null = null;
  const maxAttempts = input.source === "handheld" ? 2 : 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await deps.callModel({
        source: input.source,
        images,
        hint: input.hint,
        taxonomyPrompt,
        facetPrompt,
        brandPrompt,
        ipPrompt,
      });
      model = response.model;
      raw = response.raw;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (input.source === "handheld" && ["TimeoutError", "AbortError"].includes(lastError.name)) break;
      if (attempt < maxAttempts) await wait(200 * attempt);
    }
  }

  const failed = raw === null;
  const modelResult: RawProductRecognition = raw ?? {
    category_code: "ai_low_confidence",
    confidence: 0,
    name: "未命名中古商品",
    warning: `AI 识别暂时不可用：${lastError?.message ?? "未知错误"}`,
  };
  const normalized = normalizeProductRecognition(modelResult, categories, { facets, brands, ips });
  const status = failed ? "failed" : auditStatus(normalized);
  const saved = await deps.saveAudit({
    source: input.source,
    image_count: images.length,
    category_code: normalized.category_code,
    predicted_category_code: normalized.predicted_category_code,
    confidence: normalized.confidence,
    alternative_categories: normalized.alternative_categories,
    attributes: normalized.attributes,
    evidence: normalized.evidence,
    raw_result: failed ? { error: lastError?.message ?? "unknown AI error" } : modelResult,
    normalized_result: normalized,
    model,
    prompt_version: PRODUCT_RECOGNITION_PROMPT_VERSION,
    taxonomy_version: version,
    status,
    warning: normalized.warning,
    brand_id: normalized.brand_id,
    brand_candidate_text: normalized.brand_candidate_text,
    ip_id: normalized.ip_id,
    ip_candidate_text: normalized.ip_match_status === "review_required" ? normalized.ip_name : null,
    facet_predictions: normalized.facets,
    unmatched_facets: normalized.unmatched_facets,
    attribute_confidence: normalized.attribute_confidence,
    clarification_requests: normalized.clarification_requests,
    created_by: input.created_by,
  });

  return {
    ...normalized,
    request_id: saved.id,
    model,
    prompt_version: PRODUCT_RECOGNITION_PROMPT_VERSION,
    taxonomy_version: version,
  };
}

function parseGatewayJson(content: unknown): RawProductRecognition {
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return content as RawProductRecognition;
  }
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new Error("AI gateway returned an empty response");
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned) as RawProductRecognition;
  } catch {
    throw new Error("AI gateway returned invalid JSON");
  }
}

export async function callLovableProductModel(input: {
  source: ProductRecognitionSource;
  images: string[];
  hint?: string | null;
  taxonomyPrompt: string;
  facetPrompt: string;
  brandPrompt: string;
  ipPrompt: string;
}): Promise<{ model: string; raw: RawProductRecognition }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
  const handheld = input.source === "handheld";
  const model = handheld
    ? process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL || DEFAULT_HANDHELD_RECOGNITION_MODEL
    : process.env.PRODUCT_RECOGNITION_MODEL || DEFAULT_PRODUCT_RECOGNITION_MODEL;
  const system = `你是 BOOMER-OFF 中古杂货商品识别引擎。只输出 JSON，不要 markdown。

你必须从下面 ERP 当前启用的二级分类中选择且只选择一个 category_code，禁止创造新分类：
${input.taxonomyPrompt}

返回字段：category_code、confidence(0~1)、alternative_categories(最多3个)、name、ip_name、attributes、facet_predictions、attribute_confidence、clarification_requests、condition_grade、description、keywords、suggested_price_cny、compliance_flags、evidence、warning。
attributes 必须包含 brand、maker、origin_region、origin_country、era、material(数组)、craft(数组)、object_type、colors(数组)、dimensions、functional_status、missing_parts(数组)。
facet_predictions 必须是数组，每项包含 dimension、value、confidence；只能使用下面标签库中已有的名称或别名，不能创造正式标签：
${input.facetPrompt || "（当前标签库为空，返回空数组）"}

品牌只能参考下面品牌库。请在 attributes.brand 返回图片中识别到的原文；未匹配时保留原文，禁止创造品牌记录：
${input.brandPrompt || "（当前品牌库为空）"}

IP/角色/系列只能优先匹配下面 IP 库。ip_name 必须返回图片中可确认的最具体角色，而不是母品牌或版权公司。例如能确认 Hello Kitty 时返回 "Hello Kitty"，不能只返回其母品牌 "三丽鸥 (Sanrio)"；不确定时返回 null，禁止猜测：
${input.ipPrompt || "（当前 IP 库为空）"}

attribute_confidence 返回逐字段置信度对象，例如 brand、era、origin_country、material、craft、object_type。
clarification_requests 返回需要店员补拍或确认的问题数组，每项包含 field、question、reason；无需追问时返回空数组。
品名使用中文，不超过40字；${handheld ? "描述约20至30字，概括物件类型、可见特点和有证据的年代范围。evidence最多3条简短证据，clarification_requests最多2项。" : "描述不超过160字。"}只根据图片可见证据判断，不确定字段返回 null 或空数组。
年代有证据但无法精确到年份时，era可以写“约1980至1990年代”等大致范围，并在介绍中注明“约”；没有年代证据时era返回null，介绍可写“年代待确认”。版权年份/IP诞生年份不能作为该实物生产年份，禁止编造稀有度、真伪和收藏升值承诺。
瓷器：能确认日本产地时选日本瓷器下的 active 叶子，能确认欧洲产地时选欧洲瓷器下的 active 叶子；产地无法确认时必须返回 ai_low_confidence，并在 warning 中写明需人工核对产地，禁止猜测产地，也禁止返回 porcelain_origin_unknown（该类目已停用）。古美术不收瓷器。
游戏设备：Switch Lite 等掌上主机选 game_handheld；PS5、Xbox 等桌面主机选 game_desktop_console；实体游戏卡带/卡匣选 game_cartridge；手柄、底座、保护壳等选 game_accessory。禁止再返回 digital_game_console。
疑似受监管文物、违禁品或无法安全销售的物品，将风险写入 compliance_flags。
suggested_price_cny 只是人民币参考价，没有依据时返回 null。`;
  const userContent = [
    {
      type: "text",
      text: `${input.hint ? `店员补充：${input.hint}\n` : ""}共 ${input.images.length} 张图，第1张为主图，其余为底款、标签、瑕疵或配件。请综合识别。`,
    },
    ...input.images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    ...(handheld ? { signal: AbortSignal.timeout(25_000) } : {}),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    body: JSON.stringify({
      model,
      ...(handheld ? { max_tokens: 4096 } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI gateway ${response.status}: ${detail.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  return {
    model,
    raw: parseGatewayJson(payload.choices?.[0]?.message?.content),
  };
}

export async function recognizeProductFromImages(
  input: ProductRecognitionInput,
): Promise<ProductRecognitionResult> {
  const { loadActiveProductCategories, persistProductClassificationAudit } =
    await import("./product-classification.server");
  return runProductRecognition(input, {
    loadCategories: loadActiveProductCategories,
    loadFacets: async () => {
      const { loadActiveProductFacets } = await import("./product-classification.server");
      return loadActiveProductFacets();
    },
    loadBrands: async () => {
      const { loadActiveProductBrands } = await import("./product-classification.server");
      return loadActiveProductBrands();
    },
    loadIps: async () => {
      const { loadActiveProductIps } = await import("./product-classification.server");
      return loadActiveProductIps();
    },
    callModel: callLovableProductModel,
    saveAudit: persistProductClassificationAudit,
  });
}
