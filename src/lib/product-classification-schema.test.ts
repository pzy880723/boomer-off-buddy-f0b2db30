import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260715090000_ai_product_classification.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("AI product classification schema contract", () => {
  test("seeds the approved two-level taxonomy and porcelain regions", () => {
    for (const code of [
      "porcelain",
      "porcelain_japan",
      "porcelain_europe",
      "porcelain_china",
      "porcelain_origin_unknown",
      "toy_model",
      "audio_media",
      "digital_appliance",
      "home_decor",
      "stationery_publication",
      "fashion_wearable",
      "art_collectible",
      "daily_misc",
      "classification_pending",
      "ai_low_confidence",
      "new_category_candidate",
      "compliance_review",
    ]) {
      assert.match(migration, new RegExp(`'${code}'`));
    }
    assert.match(migration, /parent_id/);
    assert.match(migration, /UPDATE public\.inv_categories[\s\S]+is_active = false/);
  });

  test("adds structured AI metadata to inventory SKUs", () => {
    for (const column of [
      "attributes jsonb",
      "category_source text",
      "category_confidence numeric",
      "classification_status text",
      "ai_suggested_price numeric",
      "recognition_request_id uuid",
    ]) {
      assert.match(migration, new RegExp(column));
    }
    assert.match(migration, /category_confidence[\s\S]+BETWEEN 0 AND 1/);
  });

  test("creates an auditable recognition request table", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.inv_sku_classifications/);
    for (const column of [
      "predicted_category_code",
      "alternative_categories",
      "evidence",
      "raw_result",
      "normalized_result",
      "prompt_version",
      "taxonomy_version",
      "corrected_category_code",
    ]) {
      assert.match(migration, new RegExp(column));
    }
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /GRANT SELECT ON public\.inv_sku_classifications TO authenticated/);
    assert.match(migration, /GRANT ALL ON public\.inv_sku_classifications TO service_role/);
  });
});
