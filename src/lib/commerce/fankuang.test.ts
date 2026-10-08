import test from "node:test";
import assert from "node:assert/strict";
import {
  FANKUANG_PRICE_MAX,
  fankuangDefaultForPrice,
  isInFankuang,
  filterFankuangBeforePaging,
} from "./fankuang";
import { ItemPatchReq } from "../handheld/item-edit-schemas";
import { SmartCreateReq } from "../handheld/schemas";
import { itemOpFingerprint } from "../../server/handheld-item-edit.server";
import { smartCreateFingerprint } from "../../server/handheld-smart-create.server";

const custom = { is_custom_price: true, inventory_policy: "tracked", kind: "single" };

test("49.9 is in by default and 50 is out", () => {
  assert.equal(FANKUANG_PRICE_MAX, 49.9);
  assert.equal(fankuangDefaultForPrice(49.9), true);
  assert.equal(fankuangDefaultForPrice(49.91), false);
  assert.equal(fankuangDefaultForPrice(50), false);
  assert.equal(isInFankuang({ ...custom, price_tier: 49.9, fankuang_override: null }), true);
  assert.equal(isInFankuang({ ...custom, price_tier: 50, fankuang_override: null }), false);
});

test("explicit false excludes low price and explicit true includes high price", () => {
  assert.equal(isInFankuang({ ...custom, price_tier: 10, fankuang_override: false }), false);
  assert.equal(isInFankuang({ ...custom, price_tier: 999, fankuang_override: true }), true);
});

test("NULL follows price changes; manual override does not", () => {
  const sku = { ...custom, price_tier: 30, fankuang_override: null as boolean | null };
  assert.equal(isInFankuang(sku), true);
  assert.equal(isInFankuang({ ...sku, price_tier: 80 }), false);
  assert.equal(isInFankuang({ ...sku, price_tier: 80, fankuang_override: true }), true);
  assert.equal(isInFankuang({ ...sku, price_tier: 20, fankuang_override: false }), false);
});

test("standard, unlimited and bundle products never participate", () => {
  assert.equal(isInFankuang({ is_custom_price: false, inventory_policy: "unlimited", kind: "single", price_tier: 10, fankuang_override: true }), false);
  assert.equal(isInFankuang({ ...custom, inventory_policy: "unlimited", price_tier: 10, fankuang_override: true }), false);
  assert.equal(isInFankuang({ ...custom, kind: "bundle", price_tier: 10, fankuang_override: true }), false);
});

test("filter runs before paging: total excludes opted-out items and keeps high-price true", () => {
  const items = [
    { id: "a", in_fankuang: true },
    { id: "b", in_fankuang: false },
    { id: "c", in_fankuang: true },
    { id: "d", in_fankuang: true },
  ];
  const r = filterFankuangBeforePaging(items, true, 1, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.page.map((i) => i.id), ["a", "c"]);
  const r2 = filterFankuangBeforePaging(items, true, 2, 2);
  assert.deepEqual(r2.page.map((i) => i.id), ["d"]);
  assert.equal(filterFankuangBeforePaging(items, false, 1, 10).total, 4);
});

test("PATCH accepts nullable fankuang_override and omission keeps it absent", () => {
  const base = { location_id: crypto.randomUUID(), client_op_id: "op-12345678", expected_updated_at: new Date().toISOString() };
  assert.equal(ItemPatchReq.parse({ ...base, fankuang_override: false }).fankuang_override, false);
  assert.equal(ItemPatchReq.parse({ ...base, fankuang_override: null }).fankuang_override, null);
  assert.equal("fankuang_override" in ItemPatchReq.parse({ ...base, name: "x" }), false);
  assert.equal(ItemPatchReq.safeParse({ ...base, fankuang_override: "yes" }).success, false);
});

test("smart-create accepts nullable fankuang_override; omission is auto", () => {
  const body = { name: "x", category: "toy_character_figure", price_tier: 80 };
  assert.equal(SmartCreateReq.parse({ ...body, fankuang_override: true }).fankuang_override, true);
  assert.equal(SmartCreateReq.parse(body).fankuang_override, undefined);
});

test("same op is stable and a changed override produces a conflicting fingerprint", () => {
  const sku = crypto.randomUUID();
  const a = itemOpFingerprint("update", sku, { patch: { fankuang_override: true } });
  assert.equal(a, itemOpFingerprint("update", sku, { patch: { fankuang_override: true } }));
  assert.notEqual(a, itemOpFingerprint("update", sku, { patch: { fankuang_override: false } }));
  const loc = crypto.randomUUID();
  const legacy = smartCreateFingerprint({ name: "x", price_tier: 10 }, loc);
  assert.equal(legacy, smartCreateFingerprint({ name: "x", price_tier: 10, fankuang_override: undefined }, loc));
  assert.notEqual(legacy, smartCreateFingerprint({ name: "x", price_tier: 10, fankuang_override: false }, loc));
});

test("all listings of one SKU honor the same manual enrollment", () => {
  const sku = { ...custom, price_tier: 199, fankuang_override: true };
  const listings = ["shop-a", "shop-b"].map(location => ({
    location, in_fankuang: isInFankuang(sku),
  }));
  assert.deepEqual(listings.map(row => row.in_fankuang), [true, true]);
  assert.equal(filterFankuangBeforePaging(listings, true, 1, 20).total, 2);
  assert.deepEqual(["shop-a", "shop-b"].map(() => isInFankuang({
    ...sku, price_tier: 9.9, fankuang_override: false,
  })), [false, false]);
});
