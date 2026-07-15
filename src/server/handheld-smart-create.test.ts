import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { getSmartCreateReleaseTarget } from "./handheld-smart-create.server";

describe("handheld smart-create auto listing", () => {
  test("publishes to the shop bound to the selected store location", () => {
    assert.equal(
      getSmartCreateReleaseTarget({
        autoPushYouzan: true,
        locationKind: "shop",
        shopId: "shop-1",
      }),
      "shop-1",
    );
  });

  test("does not publish warehouse inventory to an arbitrary shop", () => {
    assert.equal(
      getSmartCreateReleaseTarget({
        autoPushYouzan: true,
        locationKind: "warehouse",
        shopId: null,
      }),
      null,
    );
  });

  test("respects an explicit auto-publish opt out", () => {
    assert.equal(
      getSmartCreateReleaseTarget({
        autoPushYouzan: false,
        locationKind: "shop",
        shopId: "shop-1",
      }),
      null,
    );
  });
});

describe("handheld AI classification contract", () => {
  const schemas = readFileSync("src/lib/handheld/schemas.ts", "utf8");
  const recognition = readFileSync("src/server/handheld-ai.server.ts", "utf8");
  const smartCreate = readFileSync("src/routes/api/public/handheld/items.smart-create.ts", "utf8");

  test("uses dynamic ERP category codes instead of the legacy enum", () => {
    assert.doesNotMatch(schemas, /const INV_CATEGORY = z\.enum/);
    assert.doesNotMatch(recognition, /const CATEGORY_ENUM/);
    assert.match(recognition, /recognizeProductFromImages/);
  });

  test("recognition response exposes structured classification metadata", () => {
    for (const field of [
      "request_id",
      "category_code",
      "attributes",
      "evidence",
      "taxonomy_version",
    ]) {
      assert.match(schemas, new RegExp(field), `missing ${field}`);
    }
  });

  test("smart-create accepts and persists AI metadata", () => {
    for (const field of [
      "recognition_request_id",
      "attributes",
      "category_confidence",
      "classification_status",
      "ai_suggested_price",
    ]) {
      assert.match(schemas, new RegExp(field), `schema missing ${field}`);
      assert.match(smartCreate, new RegExp(field), `handler ignores ${field}`);
    }
    assert.match(smartCreate, /assertActiveLeafCategory/);
    assert.match(smartCreate, /attachProductClassificationAuditToSku/);
  });
});
