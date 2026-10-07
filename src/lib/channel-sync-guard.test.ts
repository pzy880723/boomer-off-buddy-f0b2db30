import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateZeroingTask, isServiceBearer, canMarkSold, ZEROING_ACTIONS } from "./channel-sync-guard";

const task = { sku_id: "s1", shop_id: "shop1", channel_listing_id: "l1", action: "set_stock_zero", inventory_version: 1 };
const sold = { sku: { inventory_version: 1, sales_state: "sold_syncing", is_display: false }, stockQty: 0, listing: { sku_id: "s1", shop_id: "shop1" } };

test("only the service-role bearer may trigger; publishable apikey cannot", () => {
  assert.equal(isServiceBearer("Bearer svc-key", "svc-key"), true);
  assert.equal(isServiceBearer(null, "svc-key"), false);
  assert.equal(isServiceBearer("Bearer sb_publishable_x", "svc-key"), false);
  assert.equal(isServiceBearer("Bearer ", ""), false);
  assert.equal(isServiceBearer("svc-key", "svc-key"), false);
});

test("sold, zero stock, same version, owned listing → proceed", () => {
  assert.equal(evaluateZeroingTask(task, sold).verdict, "proceed");
  assert.deepEqual([...ZEROING_ACTIONS].sort(), ["delist", "set_stock_zero"]);
});

test("active SKU with real store stock 1 at same version (Tiffany/PinkTulip case) → superseded, never zeroed", () => {
  const r = evaluateZeroingTask({ ...task, action: "delist" }, { sku: { inventory_version: 1, sales_state: "active", is_display: true }, stockQty: 1, listing: { sku_id: "s1", shop_id: "shop1" } });
  assert.equal(r.verdict, "supersede");
});

test("store stock > 0 alone, displayed alone, or newer version → superseded", () => {
  assert.equal(evaluateZeroingTask(task, { ...sold, stockQty: 1 }).verdict, "supersede");
  assert.equal(evaluateZeroingTask(task, { ...sold, sku: { ...sold.sku, is_display: true } }).verdict, "supersede");
  assert.equal(evaluateZeroingTask(task, { ...sold, sku: { ...sold.sku, inventory_version: 2 } }).verdict, "supersede");
});

test("read failures or wrong listing ownership → block (no write, not success)", () => {
  assert.equal(evaluateZeroingTask(task, { ...sold, sku: null }).verdict, "block");
  assert.equal(evaluateZeroingTask(task, { ...sold, stockQty: null }).verdict, "block");
  assert.equal(evaluateZeroingTask(task, { ...sold, listing: null }).verdict, "block");
  assert.equal(evaluateZeroingTask(task, { ...sold, listing: { sku_id: "other", shop_id: "shop1" } }).verdict, "block");
  assert.equal(evaluateZeroingTask(task, { ...sold, listing: { sku_id: "s1", shop_id: "shop2" } }).verdict, "block");
});

test("incomplete display/version facts fail closed rather than authorizing a write", () => {
  assert.equal(evaluateZeroingTask(task, { ...sold, sku: { ...sold.sku, is_display: null } }).verdict, "block");
  assert.equal(evaluateZeroingTask(task, { ...sold, sku: { ...sold.sku, inventory_version: NaN } }).verdict, "block");
});

test("dead_letter or unfinished tasks never close the sale loop", () => {
  assert.equal(canMarkSold([{ action: "set_stock_zero", status: "succeeded" }, { action: "delist", status: "succeeded" }]), true);
  assert.equal(canMarkSold([{ action: "set_stock_zero", status: "succeeded" }, { action: "delist", status: "dead_letter" }]), false);
  assert.equal(canMarkSold([{ action: "set_stock_zero", status: "succeeded" }, { action: "delist", status: "running" }]), false);
  assert.equal(canMarkSold([{ action: "set_stock_zero", status: "succeeded" }]), false);
});
