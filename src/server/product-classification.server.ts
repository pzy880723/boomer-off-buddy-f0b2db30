import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  CategoryNode,
  NormalizedProductRecognition,
  RawProductRecognition,
} from "@/lib/product-classification";
import { activeLeafCategories } from "@/lib/product-classification";
import { normalizeLookupText, type BrandCandidate, type FacetTerm } from "@/lib/product-taxonomy";
import { resolveFacetSelection, type FacetSelectionCandidate } from "@/lib/product-facet-selection";

export async function loadActiveProductCategories(): Promise<CategoryNode[]> {
  const { data, error } = await supabaseAdmin
    .from("inv_categories" as never)
    .select("id, code, name, parent_id, is_active")
    .eq("kind", "category")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`加载 ERP 分类树失败：${error.message}`);
  return (data ?? []) as unknown as CategoryNode[];
}

export async function assertActiveLeafCategory(code: string): Promise<void> {
  const categories = await loadActiveProductCategories();
  const allowed = new Set(activeLeafCategories(categories).map((row) => row.code));
  if (!allowed.has(code)) {
    throw new Error("请选择当前启用的二级商品分类");
  }
}

export async function resolveManualProductFacets(input: {
  categoryCode: string;
  facetCodes?: string[];
  legacyTags?: string[];
}): Promise<FacetSelectionCandidate[]> {
  const [categories, facetResult] = await Promise.all([
    loadActiveProductCategories(),
    supabaseAdmin
      .from("inv_facets" as never)
      .select("id, code, name, category_codes")
      .eq("is_active", true)
      .order("dimension", { ascending: true })
      .order("sort_order", { ascending: true }),
  ]);
  if (facetResult.error) throw new Error(`加载商品标签库失败：${facetResult.error.message}`);
  return resolveFacetSelection({
    categoryCode: input.categoryCode,
    categories,
    facets: (facetResult.data ?? []) as unknown as FacetSelectionCandidate[],
    facetCodes: input.facetCodes,
    legacyTags: input.legacyTags,
  });
}

export async function replaceManualProductFacets(input: {
  skuId: string;
  facets: FacetSelectionCandidate[];
  createdBy?: string | null;
}): Promise<void> {
  const remove = await supabaseAdmin
    .from("inv_sku_facets" as never)
    .delete()
    .eq("sku_id", input.skuId)
    .eq("source", "manual");
  if (remove.error) throw new Error(`清理 SKU 旧手工标签失败：${remove.error.message}`);
  if (input.facets.length === 0) return;

  const rows = input.facets.map((facet) => ({
    sku_id: input.skuId,
    facet_id: facet.id,
    source: "manual",
    confidence: 1,
    created_by: input.createdBy ?? null,
  }));
  const saved = await supabaseAdmin
    .from("inv_sku_facets" as never)
    .upsert(rows as never, { onConflict: "sku_id,facet_id" });
  if (saved.error) throw new Error(`保存 SKU 手工标签失败：${saved.error.message}`);
}

export async function loadActiveProductFacets(): Promise<FacetTerm[]> {
  const { data, error } = await supabaseAdmin
    .from("inv_facets" as never)
    .select("code, name, dimension, aliases")
    .eq("is_active", true)
    .order("dimension", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`加载商品标签库失败：${error.message}`);
  return (data ?? []) as unknown as FacetTerm[];
}

export async function loadActiveProductBrands(): Promise<BrandCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("inv_brands" as never)
    .select("id, name, name_original, aliases")
    .eq("status", "active")
    .eq("entity_type", "brand")
    .order("name", { ascending: true });
  if (error) throw new Error(`加载品牌库失败：${error.message}`);
  return (data ?? []) as unknown as BrandCandidate[];
}

export async function loadActiveProductIps(): Promise<BrandCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("inv_brands" as never)
    .select("id, name, name_original, aliases")
    .eq("status", "active")
    .eq("entity_type", "ip")
    .order("name", { ascending: true });
  if (error) throw new Error(`加载 IP 库失败：${error.message}`);
  return (data ?? []) as unknown as BrandCandidate[];
}

export async function resolveOrCreateConfirmedIp(input: {
  name?: string | null;
  confirmed: boolean;
}): Promise<{ id: string | null; name: string | null; status: "empty" | "matched" | "review" }> {
  const name = input.name?.trim() ?? "";
  if (!name) return { id: null, name: null, status: "empty" };
  const normalized = normalizeLookupText(name);
  const ips = await loadActiveProductIps();
  const exact = ips.find((ip) =>
    [ip.name, ip.name_original, ...ip.aliases].some(
      (candidate) => normalizeLookupText(candidate) === normalized,
    ),
  );
  if (exact) return { id: exact.id, name: exact.name, status: "matched" };
  if (!input.confirmed) throw new Error("IP 未确认，请选择已有 IP 或确认新建");

  const existing = await supabaseAdmin
    .from("inv_brands" as never)
    .select("id, name, status, entity_type")
    .eq("normalized_name", normalized)
    .maybeSingle();
  if (existing.error) throw new Error(`检查 IP 候选失败：${existing.error.message}`);
  if (existing.data) {
    const row = existing.data as unknown as {
      id: string;
      name: string;
      status: string;
      entity_type: string;
    };
    if (row.entity_type !== "ip") {
      return { id: null, name, status: "review" };
    }
    return { id: row.id, name: row.name, status: row.status === "active" ? "matched" : "review" };
  }

  const created = await supabaseAdmin
    .from("inv_brands" as never)
    .insert({
      name,
      normalized_name: normalized,
      aliases: [],
      entity_type: "ip",
      status: "review",
      notes: "由手持 APP 识别并经店员确认创建，待总部审核",
    } as never)
    .select("id, name")
    .single();
  if (created.error || !created.data) {
    throw new Error(`创建 IP 候选失败：${created.error?.message ?? "no row"}`);
  }
  const row = created.data as unknown as { id: string; name: string };
  return { id: row.id, name: row.name, status: "review" };
}

export async function attachProductClassificationAuditToSku(input: {
  requestId: string;
  skuId: string;
  finalCategoryCode: string;
}): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("inv_sku_classifications" as never)
    .select("category_code, normalized_result")
    .eq("id", input.requestId)
    .maybeSingle();
  if (error) throw new Error(`读取 AI 识别审计失败：${error.message}`);
  if (!data) throw new Error("AI 识别记录不存在或已失效");

  const auditRow = data as unknown as {
    category_code: string;
    normalized_result: NormalizedProductRecognition | null;
  };
  const recognizedCategory = String(auditRow.category_code);
  const corrected = recognizedCategory !== input.finalCategoryCode;
  const now = new Date().toISOString();
  const update = {
    sku_id: input.skuId,
    ...(corrected
      ? {
          status: "corrected",
          corrected_category_code: input.finalCategoryCode,
          corrected_at: now,
        }
      : {}),
    updated_at: now,
  };
  const result = await supabaseAdmin
    .from("inv_sku_classifications" as never)
    .update(update as never)
    .eq("id", input.requestId);
  if (result.error) {
    throw new Error(`关联 AI 识别审计失败：${result.error.message}`);
  }
  if (corrected) {
    const sku = await supabaseAdmin
      .from("inv_skus")
      .update({
        category_source: "manual",
        classification_status: "corrected",
        updated_at: now,
      } as never)
      .eq("id", input.skuId);
    if (sku.error) throw new Error(`保存人工分类修正失败：${sku.error.message}`);
  }
  if (auditRow.normalized_result) {
    await applyRecognitionMetadataToSku(input.skuId, auditRow.normalized_result, now);
  }
}

export type PersistClassificationAuditInput = {
  source: "erp" | "handheld" | "migration";
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

export async function persistProductClassificationAudit(
  input: PersistClassificationAuditInput,
): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from("inv_sku_classifications" as never)
    .insert(input as never)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`保存 AI 识别审计失败：${error?.message ?? "no row"}`);
  }
  return { id: String((data as unknown as { id: string }).id) };
}

export async function linkProductClassificationToSku(input: {
  requestId: string;
  skuId: string;
  recognition: NormalizedProductRecognition;
}): Promise<void> {
  const now = new Date().toISOString();
  const audit = await supabaseAdmin
    .from("inv_sku_classifications" as never)
    .update({ sku_id: input.skuId, updated_at: now } as never)
    .eq("id", input.requestId);
  if (audit.error) throw new Error(`关联 AI 识别审计失败：${audit.error.message}`);

  await applyRecognitionMetadataToSku(input.skuId, input.recognition, now, {
    category: input.recognition.category_code,
    category_source: "ai",
    category_confidence: input.recognition.confidence,
    classification_status: input.recognition.status,
    ai_suggested_price: input.recognition.suggested_price_cny,
    recognition_request_id: input.requestId,
  });
}

async function applyRecognitionMetadataToSku(
  skuId: string,
  recognition: NormalizedProductRecognition,
  now: string,
  classificationFields: Record<string, unknown> = {},
): Promise<void> {
  const sku = await supabaseAdmin
    .from("inv_skus")
    .update({
      ...classificationFields,
      attributes: recognition.attributes,
      brand_id: recognition.brand_id,
      brand_candidate_text:
        recognition.brand_match_status === "review_required"
          ? recognition.brand_candidate_text
          : null,
      ip_id: recognition.ip_id,
      ip_candidate_text:
        recognition.ip_match_status === "review_required" ? recognition.ip_name : null,
      keywords: recognition.keywords,
      attribute_confidence: recognition.attribute_confidence,
      clarification_requests: recognition.clarification_requests,
      updated_at: now,
    } as never)
    .eq("id", skuId);
  if (sku.error) throw new Error(`保存 SKU AI 字段失败：${sku.error.message}`);

  const removeOldAiFacets = await supabaseAdmin
    .from("inv_sku_facets" as never)
    .delete()
    .eq("sku_id", skuId)
    .eq("source", "ai");
  if (removeOldAiFacets.error) {
    throw new Error(`清理 SKU 旧 AI 标签失败：${removeOldAiFacets.error.message}`);
  }

  if (recognition.facets.length > 0) {
    const facetCodes = recognition.facets.map((facet) => facet.code);
    const { data: facetRows, error: facetError } = await supabaseAdmin
      .from("inv_facets" as never)
      .select("id, code")
      .in("code", facetCodes)
      .eq("is_active", true);
    if (facetError) throw new Error(`读取 SKU 标签失败：${facetError.message}`);
    const ids = new Map(
      ((facetRows ?? []) as unknown as Array<{ id: string; code: string }>).map((row) => [
        row.code,
        row.id,
      ]),
    );
    const relations = recognition.facets
      .map((facet) => {
        const facetId = ids.get(facet.code);
        return facetId
          ? {
              sku_id: skuId,
              facet_id: facetId,
              source: "ai",
              confidence: facet.confidence,
            }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => !!row);
    if (relations.length > 0) {
      const result = await supabaseAdmin
        .from("inv_sku_facets" as never)
        .upsert(relations as never, { onConflict: "sku_id,facet_id" });
      if (result.error) throw new Error(`保存 SKU AI 标签失败：${result.error.message}`);
    }
  }
}
