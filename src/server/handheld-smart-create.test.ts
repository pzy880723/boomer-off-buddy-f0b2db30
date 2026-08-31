import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  getSmartCreateReleaseTarget,
  shouldReuseSmartCreateSku,
} from "./handheld-smart-create.server";

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

describe("handheld smart-create SKU identity", () => {
  test("never reuses a custom one-off SKU", () => {
    assert.equal(shouldReuseSmartCreateSku(true), false);
  });

  test("allows a standard SKU to reuse its catalog identity", () => {
    assert.equal(shouldReuseSmartCreateSku(false), true);
  });
});

describe("handheld AI classification contract", () => {
  const schemas = readFileSync("src/lib/handheld/schemas.ts", "utf8");
  const recognition = readFileSync("src/server/handheld-ai.server.ts", "utf8");
  const smartCreate = readFileSync("src/routes/api/public/handheld/items.smart-create.ts", "utf8");
  const classification = readFileSync("src/server/product-classification.server.ts", "utf8");

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

  test("smart-create applies recognized brands, facets and confidence to the SKU", () => {
    assert.match(classification, /normalized_result/);
    assert.match(classification, /applyRecognitionMetadataToSku/);
    assert.match(classification, /brand_id/);
    assert.match(classification, /attribute_confidence/);
    assert.match(classification, /inv_sku_facets/);
  });

  test("smart-create accepts raw images and queues non-blocking listing image jobs", () => {
    const migration = readFileSync(
      "supabase/migrations/20260831190000_handheld_async_listing_images.sql",
      "utf8",
    );
    const worker = readFileSync("src/server/handheld-listing-image-jobs.server.ts", "utf8");
    const workerRoute = readFileSync(
      "src/routes/api/public/hooks/listing-image-worker.ts",
      "utf8",
    );

    assert.match(schemas, /image_processing/);
    assert.match(smartCreate, /enqueueListingImageJobs/);
    assert.match(smartCreate, /triggerListingImageWorker/);
    assert.match(migration, /create table if not exists public\.inv_listing_image_jobs/i);
    assert.match(migration, /unique\s*\(sku_id, source_bucket, source_path\)/i);
    assert.match(worker, /sku-raw/);
    assert.match(worker, /sku-listing/);
    assert.match(worker, /processing/);
    assert.match(worker, /retryable_failed/);
    assert.match(worker, /\.select\("id"\)\s*\.maybeSingle\(\)/);
    assert.match(workerRoute, /runListingImageWorker/);
    assert.match(workerRoute, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.match(workerRoute, /Bearer \$\{serviceRoleKey\}/);
    assert.doesNotMatch(workerRoute, /SUPABASE_(?:PUBLISHABLE|ANON)_KEY/);
  });

  test("IP recognition is separate from brands and requires confirmation before creating a candidate", () => {
    const migration = readFileSync(
      "supabase/migrations/20260831190000_handheld_async_listing_images.sql",
      "utf8",
    );

    for (const field of ["ip_name", "ip_match_status", "ip_suggestions", "ip_confirmed"]) {
      assert.match(schemas, new RegExp(field), `schema missing ${field}`);
    }
    assert.match(classification, /loadActiveProductIps/);
    assert.match(classification, /resolveOrCreateConfirmedIp/);
    assert.match(classification, /entity_type/);
    assert.match(smartCreate, /resolveOrCreateConfirmedIp/);
    assert.match(migration, /add column if not exists ip_id uuid/i);
  });

  test("smart-create validates and persists manually selected ERP facets", () => {
    for (const field of ["facet_codes", "tags"]) {
      assert.match(schemas, new RegExp(field), `schema missing ${field}`);
    }
    assert.match(smartCreate, /resolveManualProductFacets/);
    assert.match(smartCreate, /replaceManualProductFacets/);
    assert.match(classification, /source:\s*"manual"/);
  });

  test("smart-create records a movement reference required by the production RPC", () => {
    assert.match(smartCreate, /p_ref_id:\s*skuId/);
  });

  test("label QR uses the stable retail barcode instead of an app-only deep link", () => {
    assert.doesNotMatch(smartCreate, /qrcode_payload:\s*`vg:\/\/sku\//);
    assert.match(smartCreate, /qrcode_payload:\s*barcode\s*\?\?/);
  });

  test("failed Youzan publication can be retried for the existing SKU", () => {
    const retryRoute = readFileSync(
      "src/routes/api/public/handheld/items.$id.sync-youzan.ts",
      "utf8",
    );
    const openapi = readFileSync("src/lib/handheld/openapi.ts", "utf8");

    assert.match(retryRoute, /releaseSkuToOfflineShopsCore/);
    assert.match(retryRoute, /userCanAccessLocation/);
    assert.match(retryRoute, /items\.sync-youzan/);
    assert.match(openapi, /items\/\{id\}\/sync-youzan/);
  });

  test("branch publication creates HQ first and recovers real branch item IDs", () => {
    const publisher = readFileSync("src/lib/youzan-offline-products.functions.ts", "utf8");

    assert.match(publisher, /ensureHqSpuLink\(args\.sku_id, branch\.id\)/);
    assert.match(publisher, /findExistingOfflineProduct/);
    assert.match(publisher, /queryYouzanOfflineProducts/);
    assert.match(publisher, /hqSpuId:\s*hqLink\.yz_item_id/);
    assert.match(publisher, /remoteExisting\.itemId/);
    assert.match(publisher, /await runStockSyncWorkerForSkus\(\[args\.sku_id\]\)/);
  });
});
