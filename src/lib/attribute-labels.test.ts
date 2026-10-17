import assert from "node:assert/strict";
import { test } from "node:test";
import { FACET_DIMENSIONS } from "./product-taxonomy.ts";
import {
  attributeKeyLabel,
  facetDimensionLabel,
  labelFacets,
  RECOGNITION_ATTRIBUTE_KEYS,
} from "./attribute-labels.ts";

test("every facet dimension has a Chinese label", () => {
  for (const d of FACET_DIMENSIONS) {
    const label = facetDimensionLabel(d);
    assert.ok(label && /[\u4e00-\u9fff]/.test(label), d);
  }
  assert.equal(facetDimensionLabel("material"), "材质");
  assert.equal(facetDimensionLabel("craft"), "工艺");
  assert.equal(facetDimensionLabel("origin"), "产地");
  assert.equal(facetDimensionLabel("object_type"), "物件形态");
});

test("unknown dimension/attribute keys never fall back to raw English", () => {
  assert.equal(facetDimensionLabel("secret_key"), null);
  assert.equal(attributeKeyLabel("internal_cost"), null);
});

test("every recognition attribute key has a Chinese label", () => {
  for (const k of RECOGNITION_ATTRIBUTE_KEYS) assert.ok(/[\u4e00-\u9fff]/.test(attributeKeyLabel(k) ?? ""), k);
});

test("labelFacets keeps dimension/code/name, adds dimension_label and drops unknown dimensions", () => {
  const out = labelFacets([
    { dimension: "craft", code: "craft_gilt", name: "描金", confidence: 0.8 },
    { dimension: "mystery", code: "x", name: "y", confidence: null },
    { dimension: "series", code: "series_noritake", name: "Noritake 职业系列", confidence: null },
  ]);
  assert.deepEqual(out, [
    { dimension: "craft", code: "craft_gilt", name: "描金", confidence: 0.8, dimension_label: "工艺" },
    {
      dimension: "series",
      code: "series_noritake",
      name: "Noritake 职业系列",
      confidence: null,
      dimension_label: "系列",
    },
  ]);
});
