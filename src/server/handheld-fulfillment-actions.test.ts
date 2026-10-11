import assert from "node:assert/strict";
import { test } from "node:test";
import {
  manualShip,
  pickupHttpStatus,
  handheldPickupRedeem,
  handheldPickupReady,
  ManualShipBody,
  PickupRedeemBody,
} from "./handheld-fulfillment-actions.ts";

const U = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";
const F = "33333333-3333-4333-8333-333333333333";
const I = "44444444-4444-4444-8444-444444444444";

function fakeRpc(data: unknown, error: { message: string } | null = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { data, error };
  };
  return { rpc, calls };
}

test("redeem passes session actor + device location, never body values", async () => {
  const { rpc, calls } = fakeRpc({ ok: true, result: "redeemed", fulfillment_id: F });
  const r = await handheldPickupRedeem(rpc, { actorUserId: U, locationId: L, input: "1234", idempotencyKey: "op-12345678" });
  assert.equal(r.status, 200);
  assert.equal(calls[0].fn, "commerce_pickup_redeem");
  assert.equal(calls[0].args.p_actor_user_id, U);
  assert.equal(calls[0].args.p_location_id, L);
  assert.equal(calls[0].args.p_code, "1234");
  assert.equal(calls[0].args.p_qr_payload, null);
});

test("QR payload goes to p_qr_payload; invalid input never reaches DB", async () => {
  const qr = "BOOMER_PICKUP:" + "a".repeat(64);
  const ok = fakeRpc({ ok: true, result: "redeemed" });
  await handheldPickupRedeem(ok.rpc, { actorUserId: U, locationId: L, input: qr, idempotencyKey: "op-12345678" });
  assert.equal(ok.calls[0].args.p_qr_payload, qr);
  const bad = fakeRpc({});
  const r = await handheldPickupRedeem(bad.rpc, { actorUserId: U, locationId: L, input: "12a4", idempotencyKey: "op-12345678" });
  assert.equal(r.status, 400);
  assert.equal(bad.calls.length, 0);
});

test("HTTP mapping for pickup results", () => {
  assert.equal(pickupHttpStatus("redeemed"), 200);
  assert.equal(pickupHttpStatus("already_redeemed"), 409);
  assert.equal(pickupHttpStatus("wrong_location"), 403);
  assert.equal(pickupHttpStatus("forbidden"), 403);
  assert.equal(pickupHttpStatus("not_found"), 404);
  assert.equal(pickupHttpStatus("rate_limited"), 429);
  assert.equal(pickupHttpStatus("refund_blocked"), 409);
  assert.equal(pickupHttpStatus("unknown_x"), 409);
});

test("rpc error is 503, not success", async () => {
  const { rpc } = fakeRpc(null, { message: "boom" });
  const r = await handheldPickupReady(rpc, { actorUserId: U, locationId: L, fulfillmentId: F, idempotencyKey: "op-12345678" });
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
});

test("body schemas reject client actor/location fields", () => {
  assert.equal(PickupRedeemBody.safeParse({ input: "1234", idempotency_key: "op-12345678", location_id: L }).success, false);
  assert.equal(
    ManualShipBody.safeParse({ provider: "sf", tracking_no: "SF1234", client_op_id: "op-12345678", lines: [{ fulfillment_item_id: I, quantity: 1 }], user_id: U }).success,
    false,
  );
  assert.equal(ManualShipBody.safeParse({ provider: "ems", tracking_no: "SF1234", client_op_id: "op-12345678", lines: [{ fulfillment_item_id: I, quantity: 1 }] }).success, false);
});

test("manual ship uses the single DB RPC and maps results", async () => {
  const ok = fakeRpc({ ok: true, result: "shipped", shipment_id: "s", replayed: false });
  const r = await manualShip(ok.rpc, { actorUserId: U, locationId: L, fulfillmentId: F, provider: "sf", trackingNo: "SF1234", lines: [{ fulfillmentItemId: I, quantity: 1 }], idempotencyKey: "op-12345678" });
  assert.equal(r.status, 200);
  assert.equal(ok.calls[0].fn, "commerce_manual_ship_fulfillment");
  assert.equal(ok.calls[0].args.p_actor_user_id, U);
  assert.deepEqual(ok.calls[0].args.p_lines, [{ fulfillment_item_id: I, quantity: 1 }]);
  for (const [result, status] of [["forbidden", 403], ["location_forbidden", 403], ["not_found", 404], ["pickup_order", 409], ["unpaid", 409], ["already_shipped", 409], ["idempotency_conflict", 409], ["qty_exceeded", 422]] as const) {
    const f = fakeRpc({ ok: false, result });
    assert.equal((await manualShip(f.rpc, { actorUserId: U, locationId: null, fulfillmentId: F, provider: "sf", trackingNo: "SF1234", lines: [{ fulfillmentItemId: I, quantity: 1 }], idempotencyKey: "op-12345678" })).status, status, result);
  }
});
