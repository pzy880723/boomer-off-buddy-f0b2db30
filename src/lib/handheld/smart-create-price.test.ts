import test from "node:test";
import assert from "node:assert/strict";
import { SmartCreateReq } from "./schemas";
import { ItemPriceYuan } from "./item-edit-schemas";

const draft = { name: "SONY TPS-L2 WALKMAN", category: "digital_audio_player", is_custom_price: true };

test("photo listing accepts the same yuan prices as product editing", () => {
  for (const price of [0.01, 59.9, 9999.9, 19800, 19800.99, 999999.99]) {
    assert.equal(ItemPriceYuan.safeParse(price).success, true);
    assert.equal(SmartCreateReq.parse({ ...draft, price_tier: price }).price_tier, price);
  }
});

test("listing rejects invalid amounts without rounding or changing units", () => {
  for (const price of [0, -1, 59.999, 1_000_000, NaN, Infinity, "19800"]) {
    assert.equal(SmartCreateReq.safeParse({ ...draft, price_tier: price }).success, false, String(price));
  }
});
