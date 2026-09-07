import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeLeafCategories,
  formatTaxonomyForPrompt,
  normalizeProductRecognition,
  type CategoryNode,
  type RawProductRecognition,
} from "./product-classification";
import type { BrandCandidate, FacetTerm } from "./product-taxonomy";

const categories: CategoryNode[] = [
  { id: "root-p", code: "porcelain", name: "瓷器", parent_id: null, is_active: true },
  {
    id: "p-eu",
    code: "porcelain_europe",
    name: "欧洲瓷器",
    parent_id: "root-p",
    is_active: true,
  },
  {
    id: "p-unknown",
    code: "porcelain_origin_unknown",
    name: "产地待确认",
    parent_id: "root-p",
    is_active: true,
  },
  { id: "root-t", code: "toy_model", name: "玩具模型", parent_id: null, is_active: true },
  {
    id: "toy-figure",
    code: "toy_character_figure",
    name: "角色人偶/软胶",
    parent_id: "root-t",
    is_active: true,
  },
  {
    id: "toy-off",
    code: "toy_inactive",
    name: "已停用玩具",
    parent_id: "root-t",
    is_active: false,
  },
  {
    id: "root-off",
    code: "inactive_root",
    name: "已停用一级",
    parent_id: null,
    is_active: false,
  },
  {
    id: "orphan-active",
    code: "orphan_active",
    name: "孤立子类",
    parent_id: "root-off",
    is_active: true,
  },
  {
    id: "root-pending",
    code: "classification_pending",
    name: "待归类",
    parent_id: null,
    is_active: true,
  },
  {
    id: "pending-low",
    code: "ai_low_confidence",
    name: "AI低置信度",
    parent_id: "root-pending",
    is_active: true,
  },
  {
    id: "pending-compliance",
    code: "compliance_review",
    name: "合规待审",
    parent_id: "root-pending",
    is_active: true,
  },
];

const facets: FacetTerm[] = [
  { code: "origin_uk", name: "英国", dimension: "origin", aliases: ["UK", "England"] },
  {
    code: "material_bone_china",
    name: "骨瓷",
    dimension: "material",
    aliases: ["Bone China"],
  },
  { code: "craft_gilt", name: "描金", dimension: "craft", aliases: ["金彩"] },
];

const brands: BrandCandidate[] = [
  {
    id: "brand-wedgwood",
    name: "Wedgwood",
    name_original: null,
    aliases: ["韦奇伍德"],
  },
];

const ips: BrandCandidate[] = [
  {
    id: "ip-hello-kitty",
    name: "Hello Kitty",
    name_original: null,
    aliases: ["凯蒂猫", "Kitty"],
  },
];

// Sanrio is a parent IP in the existing taxonomy, not a new brand identity.
const sanrio: BrandCandidate = {
  id: "existing-sanrio-parent",
  name: "三丽鸥 (Sanrio)",
  name_original: "Sanrio",
  aliases: ["三丽鸥"],
};
const kittyTaxonomy = { facets, brands, ips: [...ips, sanrio] };
const kittyRecognition: RawProductRecognition = {
  category_code: "toy_character_figure",
  confidence: 0.94,
  name: "Hello Kitty 挂件",
  ip_name: "Hello Kitty",
};

describe("bounded Hello Kitty recognition brand", () => {
  for (const ipName of ["Hello Kitty", "hello kitty", "凯蒂猫", "Kitty"]) {
    test(`fills the existing Sanrio brand for the exact character alias ${ipName}`, () => {
      const raw = { ...kittyRecognition, ip_name: ipName, attributes: { brand: null } };
      const result = normalizeProductRecognition(raw, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, sanrio.name);
      assert.equal(result.brand_id, sanrio.id);
      assert.equal(result.brand_match_status, "matched");
      assert.equal(result.brand_candidate_text, sanrio.name);
      assert.equal(result.ip_id, "ip-hello-kitty");
      assert.equal(result.ip_name, "Hello Kitty");
      assert.equal(raw.attributes.brand, null);
    });
  }

  test("uses the canonical row supplied by the taxonomy, including name-only parent rows", () => {
    for (const name of ["三丽鸥 (Sanrio)", "三丽鸥", "Sanrio"]) {
      const parent = { ...sanrio, id: `loaded-${name}`, name, name_original: null, aliases: [] };
      const result = normalizeProductRecognition(kittyRecognition, categories, {
        facets, brands: [...brands, parent], ips,
      });
      assert.equal(result.brand_id, parent.id);
      assert.equal(result.attributes.brand, parent.name);
    }
  });

  test("matches explicit Sanrio text to the parent IP without replacing the character", () => {
    const result = normalizeProductRecognition({
      ...kittyRecognition, attributes: { brand: "Sanrio" },
    }, categories, kittyTaxonomy);
    assert.equal(result.brand_id, sanrio.id);
    assert.equal(result.attributes.brand, "Sanrio");
    assert.equal(result.ip_id, "ip-hello-kitty");
  });

  test("preserves explicit conflicting brands, including a top-level brand beside blank nested text", () => {
    for (const raw of [
      { attributes: { brand: "Wedgwood" } },
      { attributes: { brand: "Unknown Collaboration" } },
      { brand: "Wedgwood" },
      { brand: "Wedgwood", attributes: { brand: "  " } },
    ]) {
      const expected = raw.attributes?.brand.trim() || raw.brand;
      const result = normalizeProductRecognition({ ...kittyRecognition, ...raw }, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, expected);
      assert.equal(result.brand_id, expected === "Wedgwood" ? "brand-wedgwood" : null);
      assert.equal(result.ip_name, "Hello Kitty");
    }
  });

  test("does not infer from a title, a fuzzy character, another character, or the parent IP alone", () => {
    for (const ip_name of [null, "Hello Kity", "Hello Kitty x Other Character", "三丽鸥", "My Melody"]) {
      const result = normalizeProductRecognition({ ...kittyRecognition, ip_name }, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, null);
      assert.equal(result.brand_id, null);
    }
  });

  test("does not infer from low or missing confidence or unresolved brand/character questions", () => {
    const uncertain: Partial<RawProductRecognition>[] = [
      { confidence: 0.4 },
      { confidence: null },
      { attribute_confidence: { ip_name: 0.3 } },
      { attribute_confidence: { ip_name: null } },
      { clarification_requests: [{ field: "ip_name", question: "Confirm character?" }] },
      { clarification_requests: [{ field: "brand", question: "Confirm collaboration brand?" }] },
    ];
    for (const raw of uncertain) {
      const result = normalizeProductRecognition({ ...kittyRecognition, ...raw }, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, null);
      assert.equal(result.brand_id, null);
    }
  });

  test("can use confident character evidence even when the category is uncertain", () => {
    const result = normalizeProductRecognition({
      ...kittyRecognition, confidence: 0.5, attribute_confidence: { ip_name: 0.96 },
      clarification_requests: [{ field: "era", question: "Confirm era?" }],
    }, categories, kittyTaxonomy);
    assert.equal(result.status, "fallback");
    assert.equal(result.brand_id, sanrio.id);
  });

  test("never invents parent or character identities when taxonomy rows are absent", () => {
    for (const taxonomy of [
      { facets, brands, ips },
      { facets, brands, ips: [sanrio] },
      { facets, brands, ips: [{ ...sanrio, aliases: ["Hello Kitty"] }] },
    ]) {
      const result = normalizeProductRecognition(kittyRecognition, categories, taxonomy);
      assert.equal(result.attributes.brand, null);
      assert.equal(result.brand_id, null);
    }
  });
});

describe("product classification policy", () => {
  test("only exposes active leaves whose parent is active", () => {
    assert.deepEqual(
      activeLeafCategories(categories).map((row) => row.code),
      [
        "porcelain_europe",
        "porcelain_origin_unknown",
        "toy_character_figure",
        "ai_low_confidence",
        "compliance_review",
      ],
    );
  });

  test("formats the live two-level taxonomy for the AI prompt", () => {
    const text = formatTaxonomyForPrompt(categories);
    assert.match(text, /porcelain_europe \| 瓷器 > 欧洲瓷器/);
    assert.doesNotMatch(text, /toy_inactive/);
    assert.doesNotMatch(text, /orphan_active/);
  });

  test("keeps a valid high-confidence leaf classification", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "porcelain_europe",
        confidence: 0.94,
        name: "英国描金骨瓷茶杯碟",
        attributes: { origin_region: "欧洲", origin_country: "英国" },
      },
      categories,
    );

    assert.equal(result.category_code, "porcelain_europe");
    assert.equal(result.status, "auto_classified");
    assert.equal(result.attributes.origin_country, "英国");
  });

  test("uses porcelain unknown-origin when the object is porcelain but origin is unclear", () => {
    const result = normalizeProductRecognition(
      {
        category_code: null,
        confidence: 0.86,
        name: "描金花卉纹茶杯",
        attributes: { material: ["瓷"], object_type: "茶杯" },
      },
      categories,
    );

    assert.equal(result.category_code, "porcelain_origin_unknown");
    assert.equal(result.status, "fallback");
  });

  test("uses the new object-based porcelain fallback after origin categories are retired", () => {
    const modernCategories = categories.map((row) =>
      row.code === "porcelain_origin_unknown"
        ? { ...row, code: "porcelain_other", name: "其他陶瓷物件" }
        : row,
    );
    const result = normalizeProductRecognition(
      {
        category_code: null,
        confidence: 0.88,
        name: "无底款陶瓷摆件",
        attributes: { material: ["陶瓷"], object_type: "摆件" },
      },
      modernCategories,
    );

    assert.equal(result.category_code, "porcelain_other");
  });

  test("uses the low-confidence leaf when confidence is below the automatic threshold", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.6,
        name: "红色软胶玩具",
      },
      categories,
    );

    assert.equal(result.category_code, "ai_low_confidence");
    assert.equal(result.status, "fallback");
    assert.equal(result.predicted_category_code, "toy_character_figure");
  });

  test("compliance flags override an otherwise valid category", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "porcelain_europe",
        confidence: 0.98,
        name: "年代不明瓷器",
        compliance_flags: ["疑似受监管文物"],
      },
      categories,
    );

    assert.equal(result.category_code, "compliance_review");
    assert.equal(result.status, "fallback");
  });

  test("normalizes sparse or invalid model output into a complete safe result", () => {
    const result = normalizeProductRecognition(
      { category_code: "invented_by_model", name: "  " },
      categories,
    );

    assert.equal(result.category_code, "ai_low_confidence");
    assert.equal(result.name, "未命名中古商品");
    assert.deepEqual(result.attributes.material, []);
    assert.deepEqual(result.keywords, []);
    assert.deepEqual(result.evidence, []);
  });

  test("normalizes facets, brand matching, and per-field confidence without inventing records", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "porcelain_europe",
        confidence: 0.95,
        name: "Wedgwood 描金骨瓷杯",
        attributes: { brand: "韦奇伍德", origin_country: "英国", material: ["骨瓷"] },
        facet_predictions: [
          { dimension: "origin", value: "UK", confidence: 0.91 },
          { dimension: "material", value: "Bone China", confidence: 0.96 },
          { dimension: "craft", value: "金彩", confidence: 0.77 },
          { dimension: "style", value: "AI 自创风格", confidence: 0.66 },
        ],
        attribute_confidence: { brand: 0.93, era: 1.5, material: -0.2 },
        clarification_requests: [
          { field: "era", question: "请补拍底款", reason: "当前图片无法确认年代" },
        ],
      },
      categories,
      { facets, brands, ips: [] },
    );

    assert.equal(result.brand_id, "brand-wedgwood");
    assert.equal(result.brand_candidate_text, "韦奇伍德");
    assert.equal(result.brand_match_status, "matched");
    assert.deepEqual(
      result.facets.map((item) => item.code),
      ["origin_uk", "material_bone_china", "craft_gilt"],
    );
    assert.equal(result.unmatched_facets[0]?.value, "AI 自创风格");
    assert.deepEqual(result.attribute_confidence, { brand: 0.93, era: 1, material: 0 });
    assert.equal(result.clarification_requests[0]?.field, "era");
  });

  test("keeps an unknown brand as a review candidate", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.9,
        attributes: { brand: "Unknown Toy Works" },
      },
      categories,
      { facets, brands, ips: [] },
    );

    assert.equal(result.brand_id, null);
    assert.equal(result.brand_candidate_text, "Unknown Toy Works");
    assert.equal(result.brand_match_status, "review_required");
  });

  test("matches an IP independently from the product brand", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.94,
        name: "Hello Kitty 陶瓷摆件",
        attributes: { brand: "Sanrio" },
        ip_name: "凯蒂猫",
      },
      categories,
      { facets, brands, ips },
    );

    assert.equal(result.ip_id, "ip-hello-kitty");
    assert.equal(result.ip_name, "Hello Kitty");
    assert.equal(result.ip_match_status, "matched");
    assert.equal(result.brand_id, null);
  });

  test("keeps an unknown IP as a review candidate instead of inventing an active record", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.91,
        name: "未知角色挂件",
        ip_name: "Moon Bunny",
      },
      categories,
      { facets, brands, ips },
    );

    assert.equal(result.ip_id, null);
    assert.equal(result.ip_name, "Moon Bunny");
    assert.equal(result.ip_match_status, "review_required");
    assert.deepEqual(result.ip_suggestions, []);
  });
});
