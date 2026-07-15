import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildBrandSearchText,
  matchBrandCandidate,
  normalizeFacetPredictions,
  type BrandCandidate,
  type FacetTerm,
} from "./product-taxonomy";

const facets: FacetTerm[] = [
  { code: "origin_japan", name: "日本", dimension: "origin", aliases: ["Japan", "日本制"] },
  { code: "material_porcelain", name: "瓷器", dimension: "material", aliases: ["陶瓷"] },
  { code: "object_coffee_cup", name: "咖啡杯", dimension: "object_type", aliases: ["咖啡杯碟"] },
  { code: "craft_gilt", name: "描金", dimension: "craft", aliases: ["金彩"] },
];

const brands: BrandCandidate[] = [
  {
    id: "brand-noritake",
    name: "Noritake",
    name_original: "ノリタケ",
    aliases: ["则武", "日本陶器会社"],
  },
  {
    id: "brand-sony",
    name: "SONY",
    name_original: "ソニー",
    aliases: ["索尼"],
  },
];

describe("compound product taxonomy", () => {
  test("normalizes model values to canonical facet terms and keeps per-field confidence", () => {
    const result = normalizeFacetPredictions(
      [
        { dimension: "origin", value: "Japan", confidence: 0.94 },
        { dimension: "material", value: "陶瓷", confidence: 0.88 },
        { dimension: "object_type", value: "咖啡杯碟", confidence: 0.91 },
        { dimension: "craft", value: "金彩", confidence: 0.72 },
        { dimension: "origin", value: "日本", confidence: 0.9 },
      ],
      facets,
    );

    assert.deepEqual(
      result.matches.map((item) => item.code),
      ["origin_japan", "material_porcelain", "object_coffee_cup", "craft_gilt"],
    );
    assert.equal(result.matches[0]?.confidence, 0.94);
    assert.deepEqual(result.unmatched, []);
  });

  test("does not invent official facet terms when the model returns an unknown value", () => {
    const result = normalizeFacetPredictions(
      [{ dimension: "style", value: "模型自创赛博昭和风", confidence: 0.82 }],
      facets,
    );

    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.unmatched, [
      { dimension: "style", value: "模型自创赛博昭和风", confidence: 0.82 },
    ]);
  });

  test("matches a brand by normalized name, original name, or alias", () => {
    assert.equal(matchBrandCandidate("noritake", brands).match?.id, "brand-noritake");
    assert.equal(matchBrandCandidate("ノリタケ", brands).match?.id, "brand-noritake");
    assert.equal(matchBrandCandidate("则武", brands).match?.id, "brand-noritake");
    assert.equal(matchBrandCandidate("索尼", brands).match?.id, "brand-sony");
  });

  test("returns a review candidate instead of creating an unknown brand", () => {
    const result = matchBrandCandidate("Noritake Studio 1978", brands);

    assert.equal(result.match, null);
    assert.equal(result.candidate_text, "Noritake Studio 1978");
    assert.equal(result.status, "review_required");
  });

  test("brand search text includes aliases and original-language names", () => {
    assert.equal(buildBrandSearchText(brands[0]!), "noritake ノリタケ 则武 日本陶器会社");
  });
});
