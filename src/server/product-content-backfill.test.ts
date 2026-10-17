// 存量详情补齐：真实模板 buildAutoProductContent + 真实 DB 函数（隔离 PG，readiness_test 库）接线测试。
// 先跑 bash tests/sql/listing_readiness/run.sh 建库；再 node --test --experimental-strip-types 本文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { applyBackfill, BACKFILL_BUILDER_VERSION, controlledImages, planBackfill, restoreBackfill,
  type BackfillDb } from "./product-content-backfill.ts";

const PSQL = "/tmp/psql.sh";
const haveDb = existsSync(PSQL);
const q = (sql: string) =>
  execFileSync(PSQL, ["-tA", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: { ...process.env, PGDB: "readiness_test" } }).toString().trim();
const lit = (v: unknown) => (v === null || v === undefined ? "NULL" : `'${String(typeof v === "string" ? v : JSON.stringify(v)).replace(/'/g, "''")}'`);

const SIG: Record<string, string[]> = {
  product_content_backfill_block_reason: ["p_sku::uuid"],
  product_content_backfill_apply: ["p_sku::uuid", "p_expected_version::int", "p_blocks::jsonb", "p_sources::jsonb", "p_builder_version::text"],
  product_content_backfill_restore: ["p_sku::uuid"],
};
const pgDb: BackfillDb = {
  async rpc(name, args) {
    const parts = SIG[name].map((s) => { const [k, t] = s.split("::"); return `${lit(args[k])}::${t}`; });
    const out = q(`SELECT to_jsonb(${name}(${parts.join(",")}))`);
    return { data: out ? JSON.parse(out) : null, error: null };
  },
  async listPublishedSkuIds(after, limit) {
    const out = q(`SELECT string_agg(sku_id::text, ',' ORDER BY sku_id) FROM (SELECT DISTINCT sku_id FROM commerce_listings
      WHERE status='published' AND sku_id::text LIKE 'd1%' ${after ? `AND sku_id > ${lit(after)}::uuid` : ""} ORDER BY sku_id LIMIT ${limit}) x`);
    return out ? out.split(",") : [];
  },
  async contentRow(skuId) {
    const out = q(`SELECT to_jsonb(c) FROM (SELECT version, published_blocks, draft_blocks FROM inv_product_content WHERE sku_id=${lit(skuId)}::uuid) c`);
    return out ? JSON.parse(out) : null;
  },
};
const input = (sku: string, withBrandHistory: boolean) => async () => ({
  sku_id: sku, name: "Hello Kitty 杯", category_name: "杯具", brand: { name: "Sanrio", name_original: null }, grade: "A",
  facets: [{ dimension: "material", name: "陶瓷" }],
  image_paths: [`sku-listing/gallery/${sku}/1.png`, `sku-raw/x/${sku}.jpg`, "https://evil.example/a.png"],
  knowledge: withBrandHistory
    ? [{ id: "k1", type: "brand", title: "Sanrio", summary: "日本角色品牌。", story: "1960年创立。", evidence: ["官网"], updated_at: "2026-10-01" }]
    : [{ id: "k2", type: "brand", title: "Sanrio", summary: "无来源", story: "编造", evidence: [], updated_at: "2026-10-01" }],
});
function mk(id: string) {
  q(`INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths) VALUES ('${id}','porcelain',100,'杯','${id}',true,ARRAY['sku-listing/gallery/${id}/1.png']);
     DELETE FROM listing_readiness WHERE sku_id='${id}';
     INSERT INTO commerce_listings (sku_id, location_id, title, price, status, published_at) VALUES ('${id}','00000000-0000-0000-0000-00000000000a','杯',100,'published',now());`);
}

test("only controlled sku-listing paths are used", () => {
  assert.deepEqual(controlledImages(["sku-listing/a.png", "sku-raw/b.jpg", "https://x/y.png"]), ["sku-listing/a.png"]);
});

test("dry-run → batch apply → retry → manual-edit CAS → restore, against real DB functions", { skip: !haveDb }, async () => {
  const a = "d1000000-0000-0000-0000-000000000001", b = "d1000000-0000-0000-0000-000000000002", c = "d1000000-0000-0000-0000-000000000003";
  q(`DELETE FROM inv_product_content WHERE sku_id::text LIKE 'd1%'; DELETE FROM commerce_listings WHERE sku_id::text LIKE 'd1%'; DELETE FROM inv_skus WHERE id::text LIKE 'd1%';`);
  mk(a); mk(b); mk(c);
  q(`INSERT INTO inv_product_content (sku_id, version, published_blocks, published_version, updated_by) VALUES ('${c}',3,'[{"id":"m","type":"paragraph","text":"人工"}]',3,'e1000000-0000-0000-0000-0000000000aa')`);
  const load = async (sku: string) => (await input(sku, sku === a)());

  const before = q(`SELECT count(*) FROM inv_product_content WHERE sku_id::text LIKE 'd1%'`);
  const plan = await planBackfill(pgDb, load, { limit: 2 });
  assert.equal(q(`SELECT count(*) FROM inv_product_content WHERE sku_id::text LIKE 'd1%'`), before, "dry-run writes nothing");
  assert.deepEqual(plan.items.map((i) => i.sku_id), [a, b]);
  assert.equal(plan.next_after, b);
  const pa = plan.items[0];
  assert.equal(pa.has_brand_history, true);
  assert.ok(JSON.stringify(pa.blocks).includes("1960年创立"));
  assert.ok(!JSON.stringify(pa.blocks).includes("sku-raw/") && !JSON.stringify(pa.blocks).includes("evil.example"));
  const pb = plan.items[1];
  assert.equal(pb.has_brand_history, false, "no evidence → no brand history");
  assert.ok(!JSON.stringify(pb.blocks).includes("编造"));

  // 人工在 dry-run 之后给 b 建了行 → CAS 冲突，不覆盖
  q(`INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, updated_by) VALUES ('${b}',1,'[{"id":"d","type":"paragraph","text":"草稿"}]','[]','e1000000-0000-0000-0000-0000000000aa')`);
  const res = await applyBackfill(pgDb, plan.items);
  assert.deepEqual(res.map((r) => r.status), ["filled", "conflict"]);
  assert.equal(q(`SELECT auto_sources->>'builder_version' FROM inv_product_content WHERE sku_id='${a}'`), BACKFILL_BUILDER_VERSION);
  assert.equal(q(`SELECT published_product_content('${a}')->'auto_sources'->1->>'id'`), "k1");

  // 下一批：c 已有人工详情跳过；重试 a 幂等；b 重新 dry-run 后按新 version 补上且保留人工草稿
  const plan2 = await planBackfill(pgDb, load, { after: b, limit: 2 });
  assert.equal(plan2.items[0].reason, "has_content");
  const retry = await applyBackfill(pgDb, (await planBackfill(pgDb, load, { skuIds: [a, b] })).items);
  assert.deepEqual(retry.map((r) => [r.status, r.reason ?? null]), [["skipped", "has_content"], ["filled", null]]);
  assert.equal(q(`SELECT draft_blocks->0->>'text' FROM inv_product_content WHERE sku_id='${b}'`), "草稿");
  assert.equal(q(`SELECT published_blocks->0->>'text' FROM inv_product_content WHERE sku_id='${c}'`), "人工");

  const restored = await restoreBackfill(pgDb, [a, b]);
  assert.deepEqual(restored.map((r) => r.status), ["restored", "restored"]);
  assert.equal(q(`SELECT count(*) FROM inv_product_content WHERE sku_id='${a}'`), "0");
  assert.equal(q(`SELECT published_blocks::text || version FROM inv_product_content WHERE sku_id='${b}'`), "[]1");
});
