import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  CategoryNode,
  NormalizedProductRecognition,
  RawProductRecognition,
} from "@/lib/product-classification";
import { activeLeafCategories } from "@/lib/product-classification";

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

export async function attachProductClassificationAuditToSku(input: {
  requestId: string;
  skuId: string;
  finalCategoryCode: string;
}): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("inv_sku_classifications" as never)
    .select("category_code")
    .eq("id", input.requestId)
    .maybeSingle();
  if (error) throw new Error(`读取 AI 识别审计失败：${error.message}`);
  if (!data) throw new Error("AI 识别记录不存在或已失效");

  const recognizedCategory = String((data as unknown as { category_code: string }).category_code);
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

  const sku = await supabaseAdmin
    .from("inv_skus")
    .update({
      category: input.recognition.category_code,
      attributes: input.recognition.attributes,
      category_source: "ai",
      category_confidence: input.recognition.confidence,
      classification_status: input.recognition.status,
      ai_suggested_price: input.recognition.suggested_price_cny,
      recognition_request_id: input.requestId,
      updated_at: now,
    } as never)
    .eq("id", input.skuId);
  if (sku.error) throw new Error(`保存 SKU AI 字段失败：${sku.error.message}`);
}
