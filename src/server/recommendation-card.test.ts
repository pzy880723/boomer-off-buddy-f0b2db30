import test from "node:test";
import assert from "node:assert/strict";
import { buildRecommendationCard, type CardDeps, type SkuRow } from "./recommendation-card.server";

const sku: SkuRow = {
  id: "s1", name: "昭和玻璃杯", category: "杯子", grade: "B", status: "active",
  sku_scope: "custom", brand_id: null, ip_id: null, keywords: ["玻璃"], image_paths: ["sku-listing/a.jpg"],
};
const goodAi = { headline: "桌上的小光泽", keywords: ["玻璃", "杯子"], intro: "日常喝水也能多一点心情。", highlights: ["通透杯身"] };

function deps(p: Partial<CardDeps> = {}): CardDeps {
  return {
    canAccessLocation: async () => true,
    loadSku: async () => sku,
    hasStockAt: async () => true,
    entityNames: async () => new Map(),
    signImage: async () => "https://signed",
    generate: async () => goodAi,
    ...p,
  };
}
const input = { userId: "u", locationId: "L", skuId: "s1" };

test("越权门店 → 403，且不调用 AI", async () => {
  let called = false;
  const r = await buildRecommendationCard(deps({ canAccessLocation: async () => false, generate: async () => { called = true; } }), input);
  assert.deepEqual(r, { ok: false, status: 403, code: "location_forbidden" });
  assert.equal(called, false);
});

test("自定义孤品不在本门店 → 403；标准品无库存行仍可生成", async () => {
  const r = await buildRecommendationCard(deps({ hasStockAt: async () => false }), input);
  assert.equal(r.ok ? 0 : r.code, "sku_not_at_location");
  const s = await buildRecommendationCard(deps({ hasStockAt: async () => false, loadSku: async () => ({ ...sku, sku_scope: "standard" }) }), input);
  assert.equal(s.ok, true);
});

test("不存在 404 / 已归档 409", async () => {
  assert.equal(((await buildRecommendationCard(deps({ loadSku: async () => null }), input)) as any).status, 404);
  assert.equal(((await buildRecommendationCard(deps({ loadSku: async () => ({ ...sku, status: "archived" }) }), input)) as any).status, 409);
});

test("AI 成功 → source=ai，尺寸 60×90，无价格字段", async () => {
  const r = await buildRecommendationCard(deps(), input);
  assert.ok(r.ok);
  assert.equal(r.card.source, "ai");
  assert.deepEqual(r.card.size_mm, { width: 60, height: 90 });
  assert.equal("price" in r.card, false);
  assert.equal(r.card.image.status, "ready");
});

test("AI 抛错 → source=product + ai_unavailable", async () => {
  const r = await buildRecommendationCard(deps({ generate: async () => { throw new Error("x"); } }), input);
  assert.ok(r.ok);
  assert.equal(r.card.source, "product");
  assert.equal(r.card.fallback_reason, "ai_unavailable");
  assert.equal(r.card.product_name, "昭和玻璃杯");
});

test("AI 编造年份/未确认品牌 → 拒绝回退 product", async () => {
  const y = await buildRecommendationCard(deps({ generate: async () => ({ ...goodAi, intro: "1985年出品的经典杯子" }) }), input);
  assert.ok(y.ok); assert.equal(y.card.fallback_reason, "ai_unsupported_claim");
  const b = await buildRecommendationCard(deps({ generate: async () => ({ ...goodAi, headline: "Pyrex 经典" }) }), input);
  assert.ok(b.ok); assert.equal(b.card.fallback_reason, "ai_unconfirmed_brand");
  const bad = await buildRecommendationCard(deps({ generate: async () => ({ headline: "x" }) }), input);
  assert.ok(bad.ok); assert.equal(bad.card.fallback_reason, "ai_invalid_output");
});

test("缺图 → image.status=missing，不伪造；二维码不生成", async () => {
  const r = await buildRecommendationCard(deps({ loadSku: async () => ({ ...sku, image_paths: [] }) }), input);
  assert.ok(r.ok);
  assert.equal(r.card.image.status, "missing");
  assert.equal(r.card.qr.status, "not_configured");
});

// —— 60×90mm 卡面容量约束（与 Codex 本地回归等价）——

test("7 字关键词超出容量 → 拒绝回退 product", async () => {
  const r = await buildRecommendationCard(
    deps({ generate: async () => ({ ...goodAi, keywords: ["玻璃", "一二三四五六七"] }) }),
    input,
  );
  assert.ok(r.ok);
  assert.equal(r.card.source, "product");
  assert.equal(r.card.fallback_reason, "ai_invalid_output");
});

test("highlights 分号连接总长 >55 被拒，=55 通过", async () => {
  const l24 = "一".repeat(24);
  // 24+24+6 + 2 个分号 = 56 → 拒绝
  const over = await buildRecommendationCard(
    deps({ generate: async () => ({ ...goodAi, highlights: [l24, l24, "六".repeat(6)] }) }),
    input,
  );
  assert.ok(over.ok);
  assert.equal(over.card.source, "product");
  assert.equal(over.card.fallback_reason, "ai_invalid_output");
  // 24+24+5 + 2 个分号 = 55 → 通过
  const exact = await buildRecommendationCard(
    deps({ generate: async () => ({ ...goodAi, highlights: [l24, l24, "五".repeat(5)] }) }),
    input,
  );
  assert.ok(exact.ok);
  assert.equal(exact.card.source, "ai");
  assert.equal(exact.card.highlights.join("；").length, 55);
});

test("长商品名 fallback：product_name ≤24、关键词 ≤6", async () => {
  const longSku: SkuRow = {
    ...sku,
    name: "昭和中古手工吹制玻璃杯大号带原装木盒收藏款三十字以上超长名称",
    keywords: ["手工吹制玻璃工艺"],
  };
  const r = await buildRecommendationCard(
    deps({ loadSku: async () => longSku, generate: async () => { throw new Error("x"); } }),
    input,
  );
  assert.ok(r.ok);
  assert.equal(r.card.source, "product");
  assert.ok(r.card.product_name.length <= 24);
  for (const k of r.card.keywords) assert.ok(k.length <= 6, `keyword ${k} too long`);
});
