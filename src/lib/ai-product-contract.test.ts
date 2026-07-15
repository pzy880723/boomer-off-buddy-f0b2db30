import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("ERP photo recognition uses the shared dynamic taxonomy service", () => {
  const source = read("src/lib/ai.functions.ts");

  assert.match(source, /recognizeProductFromImages/);
  assert.doesNotMatch(source, /const SkuRecognizeSchema/);
  assert.doesNotMatch(source, /jp_porcelain/);
});

test("ERP SKU state carries the complete AI recognition metadata", () => {
  const source = read("src/components/inventory/sku-meta-fields.tsx");

  for (const field of [
    "attributes",
    "recognitionRequestId",
    "categoryConfidence",
    "classificationStatus",
    "aiSuggestedPrice",
    "evidence",
  ]) {
    assert.match(source, new RegExp(field), `missing ${field}`);
  }
});

test("smart capture applies classification, evidence, attributes and suggested price", () => {
  const source = read("src/components/inventory/smart-sku-capture.tsx");

  for (const field of [
    "request_id",
    "category_code",
    "attributes",
    "confidence",
    "suggested_price_cny",
    "evidence",
  ]) {
    assert.match(source, new RegExp(field), `smart capture ignores ${field}`);
  }
});

test("SKU creation accepts dynamic leaf category codes and persists AI metadata", () => {
  const source = read("src/lib/inventory.functions.ts");

  assert.doesNotMatch(source, /const CATEGORY_VALUES/);
  assert.match(source, /category:\s*z\.string\(\)/);
  assert.match(source, /assertActiveLeafCategory/);
  assert.match(source, /recognition_request_id/);
  assert.match(source, /classification_status/);
  assert.match(source, /ai_suggested_price/);
});
