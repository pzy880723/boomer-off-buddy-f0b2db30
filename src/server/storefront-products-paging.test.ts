import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  buildStorefrontProduct,
  resolveStorefrontListingsImagesBatch,
  signStorefrontProductImages,
  type StorefrontListing,
  type StorefrontProduct,
} from "./storefront-products.server";

function listing(id: string, paths: string[], price = 100): StorefrontListing {
  return {
    id,
    sku_id: `sku-${id}`,
    location_id: "store-a",
    title: id,
    description: null,
    cover_url: null,
    image_urls: [],
    image_paths: paths,
    price,
    compare_at_price: null,
    condition_grade: "A",
    product_type: "custom",
    published_at: null,
    location: { id: "store-a", name: "上海店", kind: "shop" },
  };
}

function product(l: StorefrontListing, availableQty: number): StorefrontProduct {
  return buildStorefrontProduct({
    listing: l,
    sku: { id: l.sku_id, category: null, keywords: [], stock_qty: availableQty },
    category: null,
    brand: null,
    facets: [],
    availableQty,
  });
}

/** 模拟 signSkuImagePaths：记录每次调用与每次调用里涉及的桶 */
function makeSigner(calls: string[][]) {
  return async (paths: readonly string[]) => {
    calls.push([...paths]);
    return paths.map((p) => `https://signed.test/${p}`);
  };
}

describe("storefront list paging + page-only image signing", () => {
  const listRoute = readFileSync(
    new URL("../routes/api/public/storefront/products.ts", import.meta.url),
    "utf8",
  );
  const detailRoute = readFileSync(
    new URL("../routes/api/public/storefront/products.$id.ts", import.meta.url),
    "utf8",
  );
  const taxonomyRoute = readFileSync(
    new URL("../routes/api/public/storefront/taxonomy.ts", import.meta.url),
    "utf8",
  );

  test("batch signer is called once for many listings and results do not cross listings", async () => {
    const calls: string[][] = [];
    const listings = [
      listing("a", ["sku-listing/a1.png", "sku-raw/a2.png"]),
      listing("b", []),
      listing("c", ["sku-listing/c1.png"]),
    ];
    const resolved = await resolveStorefrontListingsImagesBatch(listings, makeSigner(calls));
    assert.equal(calls.length, 1, "one signer call for the whole batch");
    assert.deepEqual(calls[0], ["sku-listing/a1.png", "sku-raw/a2.png", "sku-listing/c1.png"]);
    assert.equal(resolved[0].cover_url, "https://signed.test/sku-listing/a1.png");
    assert.deepEqual(resolved[0].image_urls, [
      "https://signed.test/sku-listing/a1.png",
      "https://signed.test/sku-raw/a2.png",
    ]);
    assert.equal(resolved[1].cover_url, null);
    assert.deepEqual(resolved[1].image_urls, []);
    assert.equal(resolved[2].cover_url, "https://signed.test/sku-listing/c1.png");
    assert.deepEqual(resolved[2].image_urls, ["https://signed.test/sku-listing/c1.png"]);
  });

  test("sold filter, total and sort are computed before paging; only page items get signed", async () => {
    const all = [
      listing("p1", ["sku-listing/p1.png"], 300),
      listing("sold", ["sku-listing/sold.png"], 10),
      listing("p2", ["sku-listing/p2.png"], 200),
      listing("p3", ["sku-listing/p3.png"], 100),
    ];
    // 模拟路由：排序（price_desc）→ 富化 → 过滤 stock>0 → total → slice → 只签本页
    const sorted = [...all].sort((l, r) => Number(r.price) - Number(l.price));
    const enriched = sorted.map((l) => product(l, l.id === "sold" ? 0 : 1));
    const available = enriched.filter((p) => p.stock > 0);
    const total = available.length;
    assert.equal(total, 3, "sold listing excluded from total");
    assert.deepEqual(
      available.map((p) => p.id),
      ["p1", "p2", "p3"],
      "sort preserved after filtering",
    );
    const pageSize = 2;
    const page1 = available.slice(0, pageSize);

    const calls: string[][] = [];
    const thumbCalls: string[][] = [];
    const signed = await signStorefrontProductImages(page1, new Map(all.map((l) => [l.id, l])), {
      thumbnail: true,
      signer: makeSigner(calls),
      thumbnailSigner: async (paths) => {
        thumbCalls.push([...paths]);
        return paths.map((p) => (p ? `https://thumb.test/${p}` : null));
      },
    });
    assert.equal(signed.length, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["sku-listing/p1.png", "sku-listing/p2.png"]);
    assert.ok(
      !calls[0].includes("sku-listing/p3.png") && !calls[0].includes("sku-listing/sold.png"),
      "items outside the current page are never signed",
    );
    assert.deepEqual(thumbCalls[0], ["sku-listing/p1.png", "sku-listing/p2.png"]);
    assert.equal(signed[0].image_url, "https://signed.test/sku-listing/p1.png");
    assert.equal(signed[1].image_url, "https://signed.test/sku-listing/p2.png");
    assert.equal(
      (signed[0] as { thumbnail_url?: string }).thumbnail_url,
      "https://thumb.test/sku-listing/p1.png",
    );
    // 未签名前的 stock/price 契约不受影响
    assert.equal(signed[0].stock, 1);
    assert.equal(signed[0].price, 300);
  });

  test("thumbnail failure falls back to the original signed image", async () => {
    const l = listing("t", ["sku-listing/t.png"]);
    const [withNull] = await signStorefrontProductImages([product(l, 1)], new Map([[l.id, l]]), {
      thumbnail: true,
      signer: makeSigner([]),
      thumbnailSigner: async (paths) => paths.map(() => null),
    });
    assert.equal(
      (withNull as { thumbnail_url?: string }).thumbnail_url,
      "https://signed.test/sku-listing/t.png",
    );
    const [withThrow] = await signStorefrontProductImages([product(l, 1)], new Map([[l.id, l]]), {
      thumbnail: true,
      signer: makeSigner([]),
      thumbnailSigner: async () => {
        throw new Error("transform unavailable");
      },
    });
    assert.equal(
      (withThrow as { thumbnail_url?: string }).thumbnail_url,
      "https://signed.test/sku-listing/t.png",
    );
    // 不开 thumbnail 时不新增字段
    const [plain] = await signStorefrontProductImages([product(l, 1)], new Map([[l.id, l]]), {
      signer: makeSigner([]),
    });
    assert.equal("thumbnail_url" in plain, false);
  });

  test("list route enriches without signing, then signs only the sliced page; detail keeps originals", () => {
    assert.match(listRoute, /enrichStorefrontListings\(listings, \{ signImages: false \}\)/);
    const enrichIdx = listRoute.indexOf("signImages: false");
    const filterIdx = listRoute.indexOf("product.stock > 0");
    const totalIdx = listRoute.indexOf("const total = availableProducts.length");
    const sliceIdx = listRoute.indexOf(".slice(start, start + query.page_size)");
    const signIdx = listRoute.indexOf("signStorefrontProductImages(pageProducts");
    assert.ok(
      enrichIdx < filterIdx && filterIdx < totalIdx && totalIdx < sliceIdx && sliceIdx < signIdx,
    );
    assert.match(listRoute, /thumbnail: true/);
    assert.doesNotMatch(detailRoute, /thumbnail/);
    assert.doesNotMatch(detailRoute, /signImages: false/);
  });

  test("only taxonomy gets a public cache header; products stay uncached", () => {
    assert.match(taxonomyRoute, /Cache-Control[^\n]*public[^\n]*s-maxage=300/);
    assert.doesNotMatch(listRoute, /Cache-Control/);
    assert.doesNotMatch(detailRoute, /Cache-Control/);
  });
});
