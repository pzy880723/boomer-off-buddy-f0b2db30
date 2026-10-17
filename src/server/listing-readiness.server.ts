import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildAutoProductContent, type AutoContentKnowledge } from "@/lib/listing-auto-content";

/**
 * 上架准备编排：由真实回调（图片任务完成、新建商品、定时 hook、ERP 重试）调用。
 * 状态推导与放行都在数据库函数里（行锁 + 修订 CAS），这里只组装零 AI 模板详情。
 */
export type ReadinessOutcome =
  | { status: "legacy" }
  | { status: "waiting"; recognition: string; image: string; content: string }
  | { status: "content"; result: string; released: number };

type Refresh = {
  status: string;
  input_revision: number;
  recognition: string;
  image: string;
  content: string;
  content_revision: number | null;
};

async function loadAutoContentInput(skuId: string) {
  const { data: sku, error } = await supabaseAdmin
    .from("inv_skus")
    .select("id, name, category, grade, brand_id, image_url, image_paths")
    .eq("id", skuId)
    .maybeSingle();
  if (error || !sku) throw new Error("readiness_sku_unavailable");
  const row = sku as unknown as {
    id: string; name: string; category: string | null; grade: string | null;
    brand_id: string | null; image_url: string | null; image_paths: string[] | null;
  };
  const [category, brand, facets, relations] = await Promise.all([
    row.category
      ? supabaseAdmin.from("inv_categories" as never).select("name").eq("code", row.category).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    row.brand_id
      ? supabaseAdmin.from("inv_brands").select("name, name_original").eq("id", row.brand_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabaseAdmin.from("inv_sku_facets" as never).select("facet:inv_facets(name, dimension)").eq("sku_id", skuId),
    supabaseAdmin
      .from("official_knowledge_relations")
      .select("knowledge_id, entity_type, entity_key")
      .or(
        [row.brand_id ? `and(entity_type.eq.brand,entity_key.eq.${row.brand_id})` : null,
         row.category ? `and(entity_type.eq.primary_category,entity_key.eq.${row.category})` : null]
          .filter(Boolean).join(",") || "entity_type.eq.__none__",
      ),
  ]);
  for (const r of [category, brand, facets, relations]) if (r.error) throw new Error("readiness_facts_unavailable");
  const ids = [...new Set(((relations.data ?? []) as Array<{ knowledge_id: string }>).map((r) => r.knowledge_id))];
  let knowledge: AutoContentKnowledge[] = [];
  if (ids.length) {
    const entries = await supabaseAdmin
      .from("official_knowledge_entries")
      .select("id, type, title, summary, story, evidence, updated_at, status")
      .in("id", ids)
      .eq("status", "published");
    if (entries.error) throw new Error("readiness_knowledge_unavailable");
    // 品牌资料优先，其次品类
    knowledge = ((entries.data ?? []) as unknown as AutoContentKnowledge[]).sort((a, b) =>
      a.type === "brand" ? -1 : b.type === "brand" ? 1 : 0,
    );
  }
  const imagePaths = [...(row.image_paths ?? []), ...(row.image_url ? [row.image_url] : [])];
  return {
    sku_id: row.id,
    name: row.name,
    category_name: (category.data as { name?: string } | null)?.name ?? null,
    brand: (brand.data as { name: string; name_original: string | null } | null) ?? null,
    grade: row.grade,
    facets: ((facets.data ?? []) as unknown as Array<{ facet: { name: string; dimension: string } | null }>)
      .flatMap((f) => (f.facet ? [f.facet] : [])),
    image_paths: imagePaths,
    knowledge,
  };
}

export async function advanceListingReadiness(skuId: string): Promise<ReadinessOutcome> {
  const refresh = await supabaseAdmin.rpc("listing_readiness_refresh" as never, { p_sku: skuId } as never);
  if (refresh.error) throw new Error("readiness_refresh_failed");
  const state = refresh.data as unknown as Refresh;
  if (state.status === "legacy") return { status: "legacy" };
  const contentDone = state.content === "succeeded" && state.content_revision === state.input_revision;
  if (state.recognition !== "succeeded" || state.image !== "succeeded" || contentDone) {
    return { status: "waiting", recognition: state.recognition, image: state.image, content: state.content };
  }
  const { blocks, sources } = buildAutoProductContent(await loadAutoContentInput(skuId));
  const result = await supabaseAdmin.rpc("listing_readiness_publish_content" as never, {
    p_sku: skuId, p_revision: state.input_revision, p_blocks: blocks, p_sources: sources, p_mode: "template",
  } as never);
  if (result.error) throw new Error("readiness_content_failed");
  const data = result.data as unknown as { status: string; released?: number };
  return { status: "content", result: data.status, released: Number(data.released ?? 0) };
}

/** 安全推进：回调路径上的失败只记日志，不影响原业务结果。 */
export async function advanceListingReadinessSafe(skuId: string): Promise<void> {
  try {
    await advanceListingReadiness(skuId);
  } catch (error) {
    console.error("[listing readiness] advance failed", { skuId, error: (error as Error).message });
  }
}

/** 定时扫描：未就绪或仍有待放行意图的商品，最多 limit 个。 */
export async function sweepListingReadiness(limit = 20): Promise<{ checked: number }> {
  const { data, error } = await supabaseAdmin
    .from("listing_readiness" as never)
    .select("sku_id")
    .or("recognition_status.neq.succeeded,image_status.neq.succeeded,content_status.neq.succeeded")
    .neq("content_status", "failed")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("readiness_sweep_failed");
  const held = await supabaseAdmin
    .from("commerce_listings")
    .select("sku_id")
    .eq("readiness_hold" as never, true as never)
    .limit(limit);
  const ids = new Set([
    ...((data ?? []) as Array<{ sku_id: string }>).map((r) => r.sku_id),
    ...(((held.data ?? []) as Array<{ sku_id: string }>).map((r) => r.sku_id)),
  ]);
  for (const id of ids) await advanceListingReadinessSafe(id);
  return { checked: ids.size };
}

export async function currentReadinessRevision(skuId: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from("listing_readiness" as never)
    .select("input_revision")
    .eq("sku_id", skuId)
    .maybeSingle();
  return (data as { input_revision?: number } | null)?.input_revision ?? null;
}
