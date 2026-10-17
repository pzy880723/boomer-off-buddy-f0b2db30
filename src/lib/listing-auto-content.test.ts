import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutoProductContent } from "./listing-auto-content.ts";

const base = {
  sku_id: "sku-1",
  name: "则武描金咖啡杯",
  category_name: "杯具与饮用器",
  brand: { name: "Noritake", name_original: "ノリタケ" },
  grade: "A",
  facets: [
    { dimension: "craft", name: "描金" },
    { dimension: "origin", name: "日本" },
    { dimension: "mystery_key", name: "secret" },
  ],
  image_paths: ["sku-listing/gallery/s/1.png", "sku-listing/gallery/s/2.png", "https://evil/x.png"],
  knowledge: [],
};

test("order: cover image → title → reason → facts → detail images; only own SKU images", () => {
  const { blocks, sources } = buildAutoProductContent(base);
  assert.deepEqual(blocks.map((b) => b.id), [
    "auto-cover", "auto-title", "auto-reason", "auto-reason-text", "auto-facts", "auto-detail", "auto-detail-1",
  ]);
  assert.deepEqual(sources, [{ kind: "sku_facts", sku_id: "sku-1" }]);
  const facts = blocks.find((b) => b.id === "auto-facts") as { text: string };
  assert.match(facts.text, /工艺：描金/);
  assert.match(facts.text, /Noritake（ノリタケ）/);
  assert.doesNotMatch(facts.text, /mystery|secret/);
});

test("no knowledge → no brand intro or history story, nothing invented", () => {
  const text = JSON.stringify(buildAutoProductContent(base).blocks);
  assert.doesNotMatch(text, /品牌介绍|历史故事|\d{4}年/);
});

test("knowledge without evidence is ignored; with evidence reused with versioned source", () => {
  const entry = { id: "k1", type: "brand", title: "Noritake", summary: "日本瓷器品牌。", story: "创立故事。", updated_at: "2026-10-01T00:00:00Z" };
  const none = buildAutoProductContent({ ...base, knowledge: [{ ...entry, evidence: [] }] });
  assert.equal(none.sources.length, 1);
  const used = buildAutoProductContent({ ...base, knowledge: [{ ...entry, evidence: ["官方网站"] }] });
  assert.ok(used.blocks.some((b) => b.type === "heading" && b.text === "品牌介绍"));
  assert.ok(used.blocks.some((b) => b.type === "heading" && b.text === "历史故事"));
  assert.deepEqual(used.sources[1], { kind: "official_knowledge", id: "k1", type: "brand", title: "Noritake", version: "2026-10-01T00:00:00Z" });
});

test("HTML/URLs in source text are stripped, output passes the existing allowlist", () => {
  const { blocks } = buildAutoProductContent({ ...base, name: "<b>杯</b> https://x.y/z" });
  assert.equal((blocks[1] as { text: string }).text, "b杯/b");
});
