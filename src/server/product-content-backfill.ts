import { buildAutoProductContent, type AutoContentInput } from "../lib/listing-auto-content.ts";

/**
 * 存量自动图文详情补齐（零付费 AI，只用 buildAutoProductContent 模板 + 有据已发布资料）。
 * 资格、CAS、幂等、备份全部在数据库函数 product_content_backfill_apply 内判定；这里只组装与分批。
 * 默认 dry-run；执行需显式 apply，且每批最多 MAX_BATCH 件。
 */
export const BACKFILL_BUILDER_VERSION = "auto-content-v1";
export const MAX_BATCH = 20;

export type BackfillDb = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  /** 当前 published 的 SKU id，按 id 升序、去重，id > after。 */
  listPublishedSkuIds(after: string | null, limit: number): Promise<string[]>;
  /** inv_product_content 行的 version + 是否有已发布块；没有行返回 null。 */
  contentRow(skuId: string): Promise<{ version: number; published_blocks: unknown; draft_blocks: unknown } | null>;
};
export type LoadInput = (skuId: string) => Promise<AutoContentInput>;

export type BackfillPlanItem = {
  sku_id: string;
  name: string | null;
  reason: string | null; // null = 可补
  expected_version: number | null;
  block_count: number;
  has_brand_history: boolean;
  sources: unknown[];
  blocks: unknown[];
  original: unknown;
};

/** 只保留本 SKU 已处理受控路径（sku-listing/），不使用原图或外链。 */
export function controlledImages(paths: string[]): string[] {
  return paths.filter((p) => p.startsWith("sku-listing/"));
}

async function reasonFor(db: BackfillDb, skuId: string): Promise<string | null> {
  const r = await db.rpc("product_content_backfill_block_reason", { p_sku: skuId });
  if (r.error) throw new Error(`block_reason_failed:${skuId}`);
  return (r.data as string | null) ?? null;
}

export async function planBackfill(
  db: BackfillDb,
  loadInput: LoadInput,
  opts: { skuIds?: string[]; after?: string | null; limit?: number },
): Promise<{ items: BackfillPlanItem[]; next_after: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_BATCH, MAX_BATCH));
  const ids = opts.skuIds?.length ? opts.skuIds.slice(0, limit) : await db.listPublishedSkuIds(opts.after ?? null, limit);
  const items: BackfillPlanItem[] = [];
  for (const skuId of ids) {
    const reason = await reasonFor(db, skuId);
    const row = await db.contentRow(skuId);
    const base = { sku_id: skuId, expected_version: row?.version ?? null, original: row };
    if (reason) {
      items.push({ ...base, name: null, reason, block_count: 0, has_brand_history: false, sources: [], blocks: [] });
      continue;
    }
    const input = await loadInput(skuId);
    const { blocks, sources } = buildAutoProductContent({ ...input, image_paths: controlledImages(input.image_paths) });
    items.push({
      ...base,
      name: input.name,
      reason: blocks.length ? null : "empty_blocks",
      block_count: blocks.length,
      has_brand_history: sources.some((s) => s.kind === "official_knowledge" && s.type === "brand"),
      sources,
      blocks,
    });
  }
  return { items, next_after: ids.length === limit ? ids[ids.length - 1] : null };
}

export type BackfillApplyResult = { sku_id: string; status: string; reason?: string; version?: number };

/** 执行一批：只对计划里可补的项调用 DB CAS；跳过/冲突/已补都原样上报，可用同参数重试。 */
export async function applyBackfill(db: BackfillDb, plan: BackfillPlanItem[]): Promise<BackfillApplyResult[]> {
  const out: BackfillApplyResult[] = [];
  for (const item of plan.slice(0, MAX_BATCH)) {
    if (item.reason) {
      out.push({ sku_id: item.sku_id, status: "skipped", reason: item.reason });
      continue;
    }
    const r = await db.rpc("product_content_backfill_apply", {
      p_sku: item.sku_id,
      p_expected_version: item.expected_version,
      p_blocks: item.blocks,
      p_sources: item.sources,
      p_builder_version: BACKFILL_BUILDER_VERSION,
    });
    if (r.error) {
      out.push({ sku_id: item.sku_id, status: "error", reason: r.error.message });
      continue;
    }
    const d = r.data as { status: string; reason?: string; version?: number };
    out.push({ sku_id: item.sku_id, status: d.status, reason: d.reason, version: d.version });
  }
  return out;
}

export async function restoreBackfill(db: BackfillDb, skuIds: string[]): Promise<BackfillApplyResult[]> {
  const out: BackfillApplyResult[] = [];
  for (const skuId of skuIds) {
    const r = await db.rpc("product_content_backfill_restore", { p_sku: skuId });
    out.push(r.error ? { sku_id: skuId, status: "error", reason: r.error.message }
      : { sku_id: skuId, ...(r.data as { status: string; version?: number }) });
  }
  return out;
}
