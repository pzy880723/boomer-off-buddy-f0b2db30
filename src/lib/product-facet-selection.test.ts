import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveFacetSelection } from "./product-facet-selection";

const categories = [
  { id: "root", code: "porcelain", parent_id: null },
  { id: "leaf", code: "porcelain_drinkware", parent_id: "root" },
  { id: "other", code: "camera_film", parent_id: null },
];

const facets = [
  { id: "global", code: "origin_japan", name: "日本", category_codes: [] },
  { id: "root-facet", code: "material_porcelain", name: "瓷器", category_codes: ["porcelain"] },
  { id: "leaf-facet", code: "object_mug", name: "马克杯", category_codes: ["porcelain_drinkware"] },
  { id: "other-facet", code: "object_camera", name: "相机", category_codes: ["camera_film"] },
];

describe("custom product facet selection", () => {
  test("accepts global, parent, and leaf facets for a selected leaf category", () => {
    const selected = resolveFacetSelection({
      categoryCode: "porcelain_drinkware",
      categories,
      facets,
      facetCodes: ["origin_japan", "material_porcelain", "object_mug"],
    });

    assert.deepEqual(selected.map((row) => row.code), [
      "origin_japan",
      "material_porcelain",
      "object_mug",
    ]);
  });

  test("supports legacy tag names without allowing arbitrary free text", () => {
    const selected = resolveFacetSelection({
      categoryCode: "porcelain_drinkware",
      categories,
      facets,
      legacyTags: ["日本", "马克杯"],
    });
    assert.deepEqual(selected.map((row) => row.code), ["origin_japan", "object_mug"]);
    assert.throws(
      () =>
        resolveFacetSelection({
          categoryCode: "porcelain_drinkware",
          categories,
          facets,
          legacyTags: ["随便写的标签"],
        }),
      /不存在或已停用/,
    );
  });

  test("rejects a facet from another category", () => {
    assert.throws(
      () =>
        resolveFacetSelection({
          categoryCode: "porcelain_drinkware",
          categories,
          facets,
          facetCodes: ["object_camera"],
        }),
      /不适用于当前分类/,
    );
  });
});
