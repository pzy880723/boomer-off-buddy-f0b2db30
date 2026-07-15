import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260715153000_product_facets_and_brands.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("product facets and brands schema contract", () => {
  test("creates normalized brand, facet, and SKU relation tables", () => {
    for (const table of ["inv_brands", "inv_facets", "inv_sku_facets"]) {
      assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    }
    assert.match(migration, /aliases text\[\]/);
    assert.match(migration, /entity_type text/);
    assert.match(migration, /dimension text/);
    assert.match(migration, /source text/);
    assert.match(migration, /confidence numeric/);
  });

  test("keeps one primary category and adds normalized brand and AI review metadata", () => {
    assert.match(migration, /ALTER TABLE public\.inv_skus/);
    for (const column of [
      "brand_id uuid",
      "brand_candidate_text text",
      "attribute_confidence jsonb",
      "clarification_requests jsonb",
    ]) {
      assert.match(migration, new RegExp(column));
    }
    assert.match(migration, /REFERENCES public\.inv_brands/);
  });

  test("seeds every approved facet dimension", () => {
    for (const dimension of [
      "object_type",
      "function",
      "origin",
      "material",
      "era",
      "craft",
      "style",
      "ip",
      "character",
      "series",
      "release_method",
    ]) {
      assert.match(migration, new RegExp(`'${dimension}'`));
    }
  });

  test("provides fuzzy SKU search over names, brand aliases, categories, facets, and keywords", () => {
    assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.search_inv_skus/);
    assert.match(migration, /similarity\(/);
    assert.match(migration, /unnest\(b\.aliases\)/);
    assert.match(migration, /inv_sku_facets/);
    assert.match(migration, /keywords/);
  });

  test("enforces OR within one facet dimension and AND across dimensions", () => {
    assert.match(migration, /selected_dimensions/);
    assert.match(migration, /matched_dimensions/);
    assert.match(
      migration,
      /dt\.selected_dimensions = 0 OR sm\.matched_dimensions = dt\.selected_dimensions/,
    );
  });

  test("lets storefront root categories include their leaf products", () => {
    assert.match(migration, /JOIN public\.inv_categories parent ON parent\.id = child\.parent_id/);
    assert.match(migration, /parent\.code = p_primary_category/);
  });
});
