import assert from "node:assert/strict";
import { test } from "node:test";
import { addScannedProduct, posCartLineLabel } from "./pos-policy";
import { fromHeldCartSnapshot, toHeldCartSnapshot } from "./held-cart";
import { rankPosCharacters } from "./character-catalog";

test("brand ranks related characters without hiding other licensed characters", () => {
  const rows = [{ id: "kitty", code: "character_hello_kitty", name: "Hello Kitty", aliases: ["凯蒂猫"] },
    { id: "donald", code: "character_donald", name: "唐老鸭", aliases: ["Donald Duck"] }];
  assert.equal(rankPosCharacters(rows, { id: "66222295-6e7b-4336-8055-3a7ef23c8d7d", name: "三丽鸥" })[0].id, "kitty");
  assert.equal(rankPosCharacters(rows, { id: "a2e45bd6-7e46-4483-83c0-3a092ac949a7", name: "迪士尼" })[0].id, "donald");
  assert.equal(rankPosCharacters(rows, null, "Donald")[0].id, "donald");
  assert.equal(rankPosCharacters(rows, null, "凯蒂猫")[0].id, "kitty");
  assert.equal(rankPosCharacters(rows, { id: "bandai", name: "万代" }).length, 2);
});

test("same price and brand with different characters stays separate and survives hold", () => {
  const item = { sku_id: "sku", name: "卡通瓷器", product_type: "standard" as const,
    unit_price: 12.9, available_qty: 9999, is_unlimited_stock: true,
    brand_id: "sanrio", brand_name: "三丽鸥", character_id: "kitty", character_name: "Hello Kitty" };
  let cart = addScannedProduct([], item);
  cart = addScannedProduct(cart, { ...item, character_id: "kuromi", character_name: "库洛米" });
  cart = addScannedProduct(cart, item);
  assert.equal(cart.length, 2);
  assert.equal(cart[0].quantity, 2);
  assert.match(posCartLineLabel(cart[0]), /三丽鸥.*Hello Kitty/);
  const restored = fromHeldCartSnapshot(toHeldCartSnapshot(item));
  assert.equal(restored.character_id, "kitty");
  assert.equal(restored.character_name, "Hello Kitty");
});
