import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiscoveryTerms, countAvailableTags, DISCOVERY_LIMIT } from "./storefront-discovery.ts";

const p = (brand: string | null, facets: Array<[string, string, string]>, cat = "toy_figure") => ({
  brand: brand ? { id: brand, name: `B-${brand}` } : null,
  facets: facets.map(([dimension, code, name]) => ({ dimension, code, name })),
  primary_category: { code: cat },
});
const products = [
  p("b1", [["ip", "kitty", "Hello Kitty"], ["material", "ceramic", "陶瓷"]]),
  p("b1", [["ip", "kitty", "Hello Kitty"]]),
  p("b2", [["character", "melody", "美乐蒂"]]),
  p(null, [["series", "s1", "系列一"]], "cup"),
];
const parents = new Map([["toy_figure", "toy"], ["cup", "tableware"]]);

test("counts are per available product, exact filter semantics (brand / facet / category incl. parent)", () => {
  const c = countAvailableTags(products, parents);
  assert.equal(c.get("brand:b1")?.count, 2);
  assert.equal(c.get("facet:kitty")?.count, 2);
  assert.equal(c.get("category:toy")?.count, 3);
  assert.equal(c.get("category:tableware")?.count, 1);
  assert.equal(c.get("brand:empty"), undefined);
});

test("hot terms first by real search_count, zero-stock hot terms dropped, fallback fills with null search_count", () => {
  const c = countAvailableTags(products, parents);
  const terms = buildDiscoveryTerms([
    { term_key: "brand:noritake-empty", label: "香兰社", searchers: 9 },
    { term_key: "facet:melody", label: "美乐蒂", searchers: 3 },
    { term_key: "brand:b1", label: "B-b1", searchers: 1 },
  ], c);
  assert.ok(!terms.some((t) => t.key === "brand:noritake-empty"));
  assert.deepEqual(terms.slice(0, 2).map((t) => [t.key, t.search_count]), [["facet:melody", 3], ["brand:b1", 1]]);
  assert.deepEqual(terms[0].filters, { facet_codes: ["melody"] });
  assert.deepEqual(terms[1].filters, { brand_ids: ["b1"] });
  const fallback = terms.slice(2);
  assert.ok(fallback.length > 0 && fallback.every((t) => t.search_count === null && t.product_count > 0));
  assert.ok(!fallback.some((t) => t.key.startsWith("category:") || t.key === "facet:ceramic"), "fallback only brand/IP-like tags");
  assert.equal(fallback[0].key, "brand:b1" === terms[1].key ? "facet:kitty" : fallback[0].key);
  assert.ok(terms.every((t) => t.product_count > 0));
  assert.equal(new Set(terms.map((t) => t.key)).size, terms.length);
});

test("deterministic ordering and limit 12", () => {
  const many = Array.from({ length: 30 }, (_, i) => p(`x${String(i).padStart(2, "0")}`, []));
  const t1 = buildDiscoveryTerms([], countAvailableTags(many, new Map()));
  const t2 = buildDiscoveryTerms([], countAvailableTags([...many].reverse(), new Map()));
  assert.equal(DISCOVERY_LIMIT, 12);
  assert.equal(t1.length, 12);
  assert.deepEqual(t1.map((t) => t.key), t2.map((t) => t.key));
});

test("unknown term key formats are ignored, never generalized", () => {
  const terms = buildDiscoveryTerms([{ term_key: "q:kitty", label: "kitty", searchers: 50 }], countAvailableTags(products, parents));
  assert.ok(!terms.some((t) => t.key === "q:kitty"));
});
