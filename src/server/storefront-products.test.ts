import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  buildStorefrontProduct,
  parseStorefrontProductQuery,
  resolveStorefrontListingImages,
} from "./storefront-products.server";

describe("storefront compound taxonomy contract", () => {
  const taxonomyRoute = readFileSync(
    new URL("../routes/api/public/storefront/taxonomy.ts", import.meta.url),
    "utf8",
  );

  test("parses repeated and comma-separated brand/facet filters", () => {
    const query = parseStorefrontProductQuery(
      new URL(
        "https://example.test/products?q=则武&primary_category=porcelain_drinkware&brand_ids=a,b&brand_ids=c&facet_codes=origin_japan&facet_codes=craft_gilt,era_showa&page=2&page_size=24",
      ),
    );

    assert.deepEqual(query.brand_ids, ["a", "b", "c"]);
    assert.deepEqual(query.facet_codes, ["origin_japan", "craft_gilt", "era_showa"]);
    assert.equal(query.primary_category, "porcelain_drinkware");
    assert.equal(query.q, "则武");
    assert.equal(query.page, 2);
    assert.equal(query.page_size, 24);
  });

  test("builds the shared marketplace product DTO", () => {
    const product = buildStorefrontProduct({
      listing: {
        id: "listing-1",
        sku_id: "sku-1",
        location_id: "location-1",
        title: "Noritake 昭和描金咖啡杯碟",
        description: "杯碟一套",
        cover_url: "https://img.test/cup.jpg",
        image_urls: ["https://img.test/cup.jpg"],
        image_paths: [],
        price: 299,
        compare_at_price: 399,
        condition_grade: "A",
        product_type: "custom",
        published_at: "2026-07-15T00:00:00Z",
        location: { id: "location-1", name: "上海店", kind: "shop" },
      },
      sku: {
        id: "sku-1",
        category: "porcelain_drinkware",
        keywords: ["杯碟", "咖啡"],
        stock_qty: 2,
      },
      category: {
        code: "porcelain_drinkware",
        name: "杯具与饮用器",
        parent_name: "瓷器与陶瓷",
      },
      brand: {
        id: "brand-noritake",
        name: "Noritake",
        name_original: "ノリタケ",
        logo_url: null,
      },
      facets: [
        { dimension: "origin", code: "origin_japan", name: "日本", confidence: 0.96 },
        { dimension: "craft", code: "craft_gilt", name: "描金", confidence: 0.82 },
      ],
      availableQty: 1,
    });

    assert.equal(product.id, "listing-1");
    assert.deepEqual(product.primary_category, {
      code: "porcelain_drinkware",
      name: "杯具与饮用器",
      path: ["瓷器与陶瓷", "杯具与饮用器"],
    });
    assert.equal(product.brand?.name, "Noritake");
    assert.deepEqual(
      product.facets.map((facet) => facet.code),
      ["origin_japan", "craft_gilt"],
    );
    assert.deepEqual(product.keywords, ["杯碟", "咖啡"]);
    assert.equal(product.stock, 1);
  });

  test("uses listing store stock instead of aggregate SKU stock", () => {
    const product = buildStorefrontProduct({
      listing: {
        id: "listing-store-a",
        sku_id: "sku-shared",
        location_id: "store-a",
        title: "门店孤品",
        description: null,
        cover_url: null,
        image_urls: [],
        image_paths: [],
        price: 100,
        compare_at_price: null,
        condition_grade: "A",
        product_type: "custom",
        published_at: null,
        location: { id: "store-a", name: "上海店", kind: "shop" },
      },
      sku: { id: "sku-shared", category: null, keywords: [], stock_qty: 3 },
      category: null,
      brand: null,
      facets: [],
      availableQty: 1,
    });

    assert.equal(product.stock, 1);
  });

  test("inherits root category brand and facet applicability for leaf filters", () => {
    assert.match(taxonomyRoute, /selectedCategoryCodes\.add\(primaryCategory\)/);
    assert.match(taxonomyRoute, /selectedCategoryCodes\.add\(parent\.code\)/);
    assert.match(taxonomyRoute, /selectedCategoryCodes\.has\(code\)/);
  });

  test("resolves durable private image paths instead of persisting signed URLs", async () => {
    const listing = {
      id: "listing-images",
      sku_id: "sku-images",
      location_id: "store-a",
      title: "多角度中古杯",
      description: null,
      cover_url: "https://expired.test/old.jpg",
      image_urls: ["https://expired.test/old.jpg"],
      image_paths: ["sku-listing/front.png", "sku-listing/back.png"],
      price: 199,
      compare_at_price: null,
      condition_grade: "A",
      product_type: "custom" as const,
      published_at: null,
      location: { id: "store-a", name: "上海店", kind: "shop" },
    };

    const resolved = await resolveStorefrontListingImages(listing, async (paths) =>
      paths.map((path) => `https://signed.test/${path}`),
    );

    assert.equal(resolved.cover_url, "https://signed.test/sku-listing/front.png");
    assert.deepEqual(resolved.image_urls, [
      "https://signed.test/sku-listing/front.png",
      "https://signed.test/sku-listing/back.png",
    ]);
  });
});
