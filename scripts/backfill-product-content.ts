/**
 * 存量自动图文详情补齐 CLI（零付费 AI）。默认 dry-run，不写任何数据。
 *
 *   bun scripts/backfill-product-content.ts [--limit 10] [--after <sku_id>] [--sku a,b] [--out report.json]
 *   bun scripts/backfill-product-content.ts --apply --limit 5 --out batch1.json     # 执行一小批
 *   bun scripts/backfill-product-content.ts --restore a,b                            # 回滚（仅未被人工改过的）
 *
 * 需要 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（与站点同库）。只写 inv_product_content；
 * 不碰库存/价格/有赞/上架状态，不调用 AI。重复执行幂等：已补返回 already_filled，人工并发返回 conflict。
 */
import { writeFileSync } from "node:fs";
import { applyBackfill, MAX_BATCH, planBackfill, restoreBackfill } from "@/server/product-content-backfill";
import { backfillDb, loadBackfillInput } from "@/server/product-content-backfill.server";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  const out = val("out");
  const restore = list(val("restore"));
  if (restore) {
    const res = await restoreBackfill(backfillDb, restore);
    console.log(JSON.stringify({ mode: "restore", results: res }, null, 2));
    if (out) writeFileSync(out, JSON.stringify(res, null, 2));
    return;
  }
  const limit = Math.min(Number(val("limit") ?? 10) || 10, MAX_BATCH);
  const plan = await planBackfill(backfillDb, loadBackfillInput, { skuIds: list(val("sku")), after: val("after") ?? null, limit });
  const summary = plan.items.map((i) => ({ sku_id: i.sku_id, name: i.name, reason: i.reason, blocks: i.block_count,
    brand_history: i.has_brand_history, expected_version: i.expected_version }));
  if (!flag("apply")) {
    console.log(JSON.stringify({ mode: "dry-run", next_after: plan.next_after, items: summary }, null, 2));
    if (out) writeFileSync(out, JSON.stringify({ mode: "dry-run", plan: plan.items }, null, 2));
    return;
  }
  // 执行前把原内容快照写到报告文件（DB 内另有 auto_backfill_backup）。
  if (!out) throw new Error("--apply requires --out <report.json> (original-content snapshot is written first)");
  const report: Record<string, unknown> = { mode: "apply", at: new Date().toISOString(), next_after: plan.next_after,
    originals: plan.items.map((i) => ({ sku_id: i.sku_id, original: i.original })) };
  writeFileSync(out, JSON.stringify(report, null, 2));
  const results = await applyBackfill(backfillDb, plan.items);
  writeFileSync(out, JSON.stringify({ ...report, results }, null, 2));
  console.log(JSON.stringify({ mode: "apply", next_after: plan.next_after, results }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
