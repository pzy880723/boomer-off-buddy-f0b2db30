import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeLeafCategories,
  formatTaxonomyForPrompt,
  normalizeProductRecognition,
  type CategoryNode,
} from "./product-classification";

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
});
