import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EngagementBody, matchVocabulary, sortByPopular } from "./storefront-engagement";
import { filterFankuangBeforePaging } from "./fankuang";

const pid = "11111111-1111-4111-8111-111111111111";
const vocab = [
  { key: "brand:b1", label: "Noritake", query: "Noritake", aliases: ["则武"] },
  { key: "facet:showa", label: "昭和", query: "昭和", aliases: [] },
];

describe("engagement body", () => {
  test("rejects client user_id and totals", () => {
    assert.equal(EngagementBody.safeParse({ kind: "open", product_id: pid, user_id: "x" }).success, false);
    assert.equal(EngagementBody.safeParse({ kind: "open", product_id: pid, favorite_count: 9 }).success, false);
  });
  test("requires product_id / selected / query by kind", () => {
    assert.equal(EngagementBody.safeParse({ kind: "open" }).success, false);
    assert.equal(EngagementBody.safeParse({ kind: "favorite", product_id: pid }).success, false);
    assert.equal(EngagementBody.safeParse({ kind: "favorite", product_id: pid, selected: false }).success, true);
    assert.equal(EngagementBody.safeParse({ kind: "search", query: " " }).success, false);
    assert.equal(EngagementBody.safeParse({ kind: "search", query: "x".repeat(41) }).success, false);
  });
});

describe("search vocabulary privacy", () => {
  test("matches name/alias case-insensitively", () => {
    assert.equal(matchVocabulary(" noritake ", vocab)?.key, "brand:b1");
    assert.equal(matchVocabulary("则武", vocab)?.key, "brand:b1");
  });
  test("drops phone numbers, addresses and free text", () => {
    assert.equal(matchVocabulary("13800138000", vocab), null);
    assert.equal(matchVocabulary("上海市黄浦区某路100号", vocab), null);
    assert.equal(matchVocabulary("我想要便宜的", vocab), null);
  });
});

describe("popular sort", () => {
  const p = (id: string, v: number, f: number, at: string) => ({ id, view_count: v, favorite_count: f, published_at: at, stock: 1, in_fankuang: false });
  test("open + 3x favorite, ties newest then id", () => {
    const out = sortByPopular([p("a", 3, 0, "2026-01-01"), p("b", 0, 2, "2026-01-01"), p("c", 1, 0, "2026-02-01"), p("d", 1, 0, "2026-03-01")]);
    assert.deepEqual(out.map((x) => x.id), ["b", "a", "d", "c"]);
  });
  test("zero data falls back to newest and pages stably", () => {
    const items = Array.from({ length: 5 }, (_, i) => p(`z${i}`, 0, 0, `2026-0${i + 1}-01`));
    const sorted = sortByPopular(items);
    assert.deepEqual(sorted.map((x) => x.id), ["z4", "z3", "z2", "z1", "z0"]);
    const page2 = filterFankuangBeforePaging(sorted, false, 2, 2);
    assert.equal(page2.total, 5);
    assert.deepEqual(page2.page.map((x) => x.id), ["z2", "z1"]);
  });
});
