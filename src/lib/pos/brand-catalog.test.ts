import assert from "node:assert/strict";
import { test } from "node:test";
import { isPosBrand, rankPosBrands } from "./brand-catalog";
import { addScannedProduct, posCartLineLabel } from "./pos-policy";
import { fromHeldCartSnapshot, toHeldCartSnapshot } from "./held-cart";

test("brands exclude characters and inactive records, but include known misclassified companies", () => {
  assert.equal(isPosBrand({ id: "kitty", entity_type: "ip", status: "active" }), false);
  assert.equal(isPosBrand({ id: "x", entity_type: "brand", status: "review" }), false);
  assert.equal(isPosBrand({ id: "x", entity_type: "kiln", status: "active" }), true);
  assert.equal(isPosBrand({ id: "66222295-6e7b-4336-8055-3a7ef23c8d7d", entity_type: "ip", status: "active" }), true);
});
test("category recommendations do not hide brands from search", () => {
  const brands = [{ id: "sony", name: "索尼 Sony", aliases: [], category_codes: [] },
    { id: "noritake", name: "Noritake", aliases: ["则武"], category_codes: [] }];
  assert.equal(rankPosBrands(brands, "porcelain_jp")[0].id, "noritake");
  assert.equal(rankPosBrands(brands, "porcelain_jp", "Sony")[0].id, "sony");
  assert.equal(rankPosBrands(brands, "porcelain_jp", "则武")[0].id, "noritake");
});
test("different brands keep separate cart lines and survive held-cart snapshots", () => {
  const item = { sku_id: "sku", name: "玩具模型", product_type: "standard" as const,
    unit_price: 12.9, available_qty: 9999, is_unlimited_stock: true,
    subcategory_code: "toy_plush", subcategory_name: "毛绒玩具", brand_id: "sanrio", brand_name: "三丽鸥" };
  let cart = addScannedProduct([], item);
  cart = addScannedProduct(cart, { ...item, brand_id: "sanx", brand_name: "San-X" });
  cart = addScannedProduct(cart, item);
  assert.equal(cart.length, 2);
  assert.equal(cart[0].quantity, 2);
  assert.match(posCartLineLabel(cart[0]), /毛绒玩具.*三丽鸥/);
  const restored = fromHeldCartSnapshot(toHeldCartSnapshot(item));
  assert.equal(restored.brand_id, "sanrio");
  assert.equal(restored.brand_name, "三丽鸥");
});
