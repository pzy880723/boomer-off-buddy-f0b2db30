import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandheldOpenApi } from "./openapi";

test("handheld pickup + manual-ship contract documented", () => {
  const doc = buildHandheldOpenApi();
  const ship = doc.paths?.["/api/public/handheld/fulfillments/{id}/manual-ship"]?.post;
  const redeem = doc.paths?.["/api/public/handheld/pickup/redeem"]?.post;
  const ready = doc.paths?.["/api/public/handheld/pickup/ready"]?.post;
  for (const op of [ship, redeem, ready]) assert.ok(op?.requestBody, "requestBody");
  for (const k of ["already_shipped", "idempotency_conflict", "pickup_order", "refund_blocked", "location_forbidden"]) assert.match(String(ship?.description), new RegExp(k));
  for (const k of ["BOOMER_PICKUP", "already_redeemed", "wrong_location", "rate_limited", "429"]) assert.match(String(redeem?.description), new RegExp(k));
  // 旧接口仍在
  assert.ok(doc.paths?.["/api/public/handheld/fulfillments/{id}/waybill"]?.get);
});

test("handheld flash-deliver contract documented", () => {
  const doc = buildHandheldOpenApi();
  const flash = doc.paths?.["/api/public/handheld/fulfillments/{id}/flash-deliver"]?.post;
  assert.ok(flash?.requestBody, "requestBody");
  for (const k of ["not_flash_order", "flash_order", "SHANSONG_COD", "replayed", "shortage_blocked", "location_forbidden"]) assert.match(String(flash?.description), new RegExp(k));
});
