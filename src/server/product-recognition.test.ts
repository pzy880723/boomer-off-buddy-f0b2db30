import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AiRecognizeReq } from "../lib/handheld/schemas";
import type { CategoryNode } from "../lib/product-classification";
import type { BrandCandidate, FacetTerm } from "../lib/product-taxonomy";
import {
  buildEraInstruction,
  DEFAULT_HANDHELD_PRODUCT_RECOGNITION_MODEL,
  DEFAULT_PRODUCT_RECOGNITION_MODEL,
  HANDHELD_RECOGNITION_MAX_ATTEMPTS,
  HANDHELD_RECOGNITION_TIMEOUT_MS,
  isRecognitionTimeoutError,
  recognitionAttemptPolicy,
  resolveProductRecognitionModel,
  runProductRecognition,
  type ProductRecognitionAuditInput,
  type ProductRecognitionDeps,
} from "./product-recognition.server";


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
    id: "pending-new",
    code: "new_category_candidate",
    name: "新品类候选",
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
  { code: "origin_uk", name: "英国", dimension: "origin", aliases: ["UK"] },
  { code: "material_bone_china", name: "骨瓷", dimension: "material", aliases: [] },
];

const brands: BrandCandidate[] = [
  { id: "brand-wedgwood", name: "Wedgwood", name_original: null, aliases: ["韦奇伍德"] },
];

function depsFor(
  modelCall: ProductRecognitionDeps["callModel"],
  audits: ProductRecognitionAuditInput[],
): ProductRecognitionDeps {
  return {
    loadCategories: async () => categories,
    loadFacets: async () => facets,
    loadBrands: async () => brands,
    callModel: modelCall,
    saveAudit: async (input) => {
      audits.push(input);
      return { id: `audit-${audits.length}` };
    },
    sleep: async () => {},
  };
}

describe("shared product recognition core", () => {
  test("recognizes European porcelain against the live taxonomy and persists an audit", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    const result = await runProductRecognition(
      { images: ["data:image/jpeg;base64,abc"], source: "erp" },
      depsFor(async ({ taxonomyPrompt, facetPrompt, brandPrompt }) => {
        assert.match(taxonomyPrompt, /porcelain_europe \| 瓷器 > 欧洲瓷器/);
        assert.match(facetPrompt, /origin_uk \| origin \| 英国/);
        assert.match(brandPrompt, /Wedgwood/);
        return {
          model: "test-vision",
          raw: {
            category_code: "porcelain_europe",
            confidence: 0.96,
            name: "Wedgwood 描金骨瓷茶杯碟",
            attributes: {
              brand: "Wedgwood",
              origin_region: "欧洲",
              origin_country: "英国",
              material: ["骨瓷"],
              object_type: "茶杯碟",
            },
            facet_predictions: [
              { dimension: "origin", value: "UK", confidence: 0.92 },
              { dimension: "material", value: "骨瓷", confidence: 0.95 },
            ],
            attribute_confidence: { brand: 0.96, origin_country: 0.92 },
            evidence: ["底款可见 Wedgwood"],
            suggested_price_cny: 399,
          },
        };
      }, audits),
    );

    assert.equal(result.request_id, "audit-1");
    assert.equal(result.category_code, "porcelain_europe");
    assert.equal(result.attributes.origin_country, "英国");
    assert.equal(result.brand_id, "brand-wedgwood");
    assert.deepEqual(
      result.facets.map((item) => item.code),
      ["origin_uk", "material_bone_china"],
    );
    assert.equal(result.suggested_price_cny, 399);
    assert.equal(audits[0].status, "completed");
    assert.equal(audits[0].image_count, 1);
    assert.equal(audits[0].brand_id, "brand-wedgwood");
    assert.equal(audits[0].facet_predictions.length, 2);
  });

  test("normalizes an invented category into the automatic fallback", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    const result = await runProductRecognition(
      { images: ["https://img.example/item.jpg"], source: "handheld" },
      depsFor(
        async () => ({
          model: "test-vision",
          raw: {
            category_code: "model_invented_this",
            confidence: 0.9,
            name: "无法归类的杂货",
          },
        }),
        audits,
      ),
    );

    assert.equal(result.category_code, "ai_low_confidence");
    assert.equal(result.status, "fallback");
    assert.equal(audits[0].status, "fallback");
  });

  test("retries transient gateway errors before succeeding", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    let attempts = 0;
    const result = await runProductRecognition(
      { images: ["data:image/jpeg;base64,abc"], source: "erp" },
      depsFor(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary gateway error");
        return {
          model: "test-vision",
          raw: {
            category_code: "toy_character_figure",
            confidence: 0.91,
            name: "昭和软胶怪兽",
          },
        };
      }, audits),
    );

    assert.equal(attempts, 3);
    assert.equal(result.category_code, "toy_character_figure");
    assert.equal(audits.length, 1);
  });

  test("returns and audits a safe fallback after all gateway attempts fail", async () => {
    const audits: ProductRecognitionAuditInput[] = [];
    let attempts = 0;
    const result = await runProductRecognition(
      { images: ["data:image/jpeg;base64,abc"], source: "erp" },
      depsFor(async () => {
        attempts += 1;
        throw new Error("gateway unavailable");
      }, audits),
    );

    assert.equal(attempts, 3);
    assert.equal(result.category_code, "ai_low_confidence");
    assert.match(result.warning ?? "", /gateway unavailable/);
    assert.equal(audits[0].status, "failed");
  });
});
