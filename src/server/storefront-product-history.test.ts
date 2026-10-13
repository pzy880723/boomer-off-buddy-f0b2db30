import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildStorefrontProductDetail, STOREFRONT_DETAIL_READABLE_STATUSES } from "./storefront-products.server";

const listing = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "L", sku_id: "S", location_id: "loc", title: "Kitty", description: null, cover_url: null, image_urls: [],
  image_paths: [], price: 39, compare_at_price: null, condition_grade: "A", product_type: "custom",
  published_at: "2026-10-01T00:00:00Z", location: null, status, ...extra,
}) as any;
const product = (stock: number) => ({ id: "L", sku_id: "S", stock, available_qty: stock, image_urls: [], price: 39 }) as any;
const noSign = { thumbnailSigner: async (v: readonly string[]) => v.map(() => null), coverThumbnailSigner: async (v: readonly string[]) => v.map(() => null) };

test("published + in stock: purchasable, availability available", async () => {
  const out = await buildStorefrontProductDetail(listing("published"), { ...noSign, enrich: async () => [product(2)] });
  assert.equal(out?.purchasable, true);
  assert.equal(out?.availability, "available");
  assert.equal(out?.stock, 2);
});

test("sold / archived / published-zero-stock: readable, stock forced 0, not purchasable", async () => {
  for (const [status, stock, want] of [["sold", 1, "sold_out"], ["archived", 3, "off_shelf"], ["published", 0, "sold_out"], ["reserved", 0, "reserved"]] as const) {
    const calls: any[] = [];
    const out = await buildStorefrontProductDetail(listing(status), { ...noSign,
      enrich: async (_l, o: any) => { calls.push(o); return o.historical || (status === "published" && stock === 0) ? [product(stock)] : []; } });
    assert.ok(out, status);
    assert.equal(out!.stock, 0);
    assert.equal(out!.available_qty, 0);
    assert.equal(out!.purchasable, false);
    assert.equal(out!.availability, want);
    assert.equal(out!.listing_status, status);
  }
});

test("published but SKU hidden by merchant: read-only off_shelf", async () => {
  const out = await buildStorefrontProductDetail(listing("published"), { ...noSign,
    enrich: async (_l, o: any) => (o.historical ? [product(1)] : []) });
  assert.equal(out?.availability, "off_shelf");
  assert.equal(out?.stock, 0);
});

test("never-published, draft or hidden listings are not readable", async () => {
  assert.deepEqual([...STOREFRONT_DETAIL_READABLE_STATUSES].sort(), ["archived", "published", "reserved", "sold"]);
  for (const l of [listing("draft"), listing("hidden"), listing("sold", { published_at: null })])
    assert.equal(await buildStorefrontProductDetail(l, { ...noSign, enrich: async () => [product(1)] }), null);
  // Missing SKU row stays 404 even historically.
  assert.equal(await buildStorefrontProductDetail(listing("sold"), { ...noSign, enrich: async () => [] }), null);
});

test("route reads only readable statuses with published_at; list route still published + stock>0 only", () => {
  const detail = readFileSync(new URL("../routes/api/public/storefront/products.$id.ts", import.meta.url), "utf8");
  assert.match(detail, /\.in\("status", \[\.\.\.STOREFRONT_DETAIL_READABLE_STATUSES\]\)/);
  assert.match(detail, /\.not\("published_at", "is", null\)/);
  assert.doesNotMatch(detail, /\.eq\("status", "published"\)/);
  const list = readFileSync(new URL("../routes/api/public/storefront/products.ts", import.meta.url), "utf8");
  assert.match(list, /\.eq\("status", "published"\)/);
  assert.match(list, /product\.stock > 0/);
  assert.doesNotMatch(list, /historical/);
});

test("historical enrichment keeps SKU existence + status enum, drops only the display gate", () => {
  const src = readFileSync(new URL("./storefront-products.server.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function enrichStorefrontListings"));
  assert.match(body, /historical \? \["active", "archived"\] : \["active"\]/);
  assert.match(body, /if \(!historical\) skuQuery = skuQuery\.eq\("is_display", true\)/);
});
