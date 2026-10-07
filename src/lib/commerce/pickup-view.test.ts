import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCustomerPickups, parsePickupInput, pickupResultMessage, pickupCreateGuard } from "./pickup-view";

const L1 = "a0000000-0000-4000-8000-000000000001";
const base = {
  order: { fulfillment_method: "pickup", payment_status: "paid", order_status: "processing" },
  fulfillments: [{ id: "f1", location_id: L1, status: "allocated", store_name: "新天地店", store_address: "上海市" }],
  codes: [{ fulfillment_id: "f1", code: "0042", qr_token: "a".repeat(64), status: "active", redeemed_at: null }],
  refundActive: false,
  shortageFulfillmentIds: [] as string[],
};

describe("customer pickup credentials", () => {
  test("paid & preparing returns 4-digit code with leading zero and QR payload", () => {
    const [p] = buildCustomerPickups(base);
    assert.deepEqual(p, { fulfillment_id: "f1", location_id: L1, store_name: "新天地店", store_address: "上海市",
      status: "preparing", code: "0042", qr_payload: `BOOMER_PICKUP:${"a".repeat(64)}`, redeemed_at: null });
  });
  test("ready once stock is prepared", () => {
    const [p] = buildCustomerPickups({ ...base, fulfillments: [{ ...base.fulfillments[0], status: "handover_ready" }] });
    assert.equal(p.status, "ready");
  });
  test("unpaid or express orders expose no credentials", () => {
    assert.deepEqual(buildCustomerPickups({ ...base, order: { ...base.order, payment_status: "unpaid" } }), []);
    assert.deepEqual(buildCustomerPickups({ ...base, order: { ...base.order, fulfillment_method: "shipping" } }), []);
  });
  test("refund/cancel/shortage block immediately and strip credentials", () => {
    for (const v of [
      { ...base, order: { ...base.order, payment_status: "refund_pending" } },
      { ...base, order: { ...base.order, payment_status: "refunded", order_status: "closed" } },
      { ...base, order: { ...base.order, order_status: "cancelled" } },
      { ...base, refundActive: true },
      { ...base, shortageFulfillmentIds: ["f1"] },
    ]) {
      const [p] = buildCustomerPickups(v);
      assert.equal(p.status, "blocked");
      assert.equal(p.code, null);
      assert.equal(p.qr_payload, null);
    }
  });
  test("redeemed shows time but no reusable credential", () => {
    const [p] = buildCustomerPickups({ ...base, codes: [{ ...base.codes[0], status: "redeemed", redeemed_at: "2026-10-07T12:00:00Z" }] });
    assert.equal(p.status, "redeemed");
    assert.equal(p.code, null);
    assert.equal(p.redeemed_at, "2026-10-07T12:00:00Z");
  });
});

describe("scanner/manual input", () => {
  test("QR text and 4-digit codes are recognized, everything else rejected", () => {
    assert.deepEqual(parsePickupInput(` BOOMER_PICKUP:${"b".repeat(64)}\n`), { kind: "qr", value: `BOOMER_PICKUP:${"b".repeat(64)}` });
    assert.deepEqual(parsePickupInput("0007"), { kind: "code", value: "0007" });
    for (const bad of ["7", "12345", "abcd", "BOOMER_PICKUP:xyz", "https://x"]) assert.equal(parsePickupInput(bad), null);
  });
  test("every RPC result has a Chinese message", () => {
    for (const r of ["redeemed","already_redeemed","not_found","wrong_location","not_ready","refund_blocked","shortage_blocked","cancelled","unpaid","forbidden","rate_limited","invalid_input","fulfillment_mismatch","not_pickup","ready","already_ready","exception"]) {
      assert.match(pickupResultMessage(r), /[\u4e00-\u9fa5]/, r);
    }
  });
});

describe("order create guard", () => {
  test("pickup requires STORE_PICKUP and an empty address; express unchanged", () => {
    assert.equal(pickupCreateGuard({ fulfillment_method: "pickup", courier_service_code: "STORE_PICKUP", shipping_address: {} }), null);
    assert.equal(pickupCreateGuard({ fulfillment_method: "pickup", courier_service_code: "PLATFORM_RECOMMENDED", shipping_address: {} }), "pickup_courier_invalid");
    assert.equal(pickupCreateGuard({ fulfillment_method: "pickup", courier_service_code: "STORE_PICKUP", shipping_address: { city: "x" } }), "pickup_address_must_be_empty");
    assert.equal(pickupCreateGuard({ fulfillment_method: "express", courier_service_code: "STORE_PICKUP", shipping_address: {} }), "store_pickup_requires_pickup_method");
    assert.equal(pickupCreateGuard({ fulfillment_method: "express", courier_service_code: "PLATFORM_RECOMMENDED", shipping_address: { a: 1 } }), null);
  });
});

describe("order list pickup projection", () => {
  test("list exposes only per-store status and redeemed time, never codes or tokens", async () => {
    const { buildPickupListProjection } = await import("./pickup-view");
    const rows = buildPickupListProjection({
      order: { fulfillment_method: "pickup", payment_status: "paid", order_status: "processing" },
      fulfillments: [
        { id: "f1", location_id: "L1", status: "allocated", handed_over_at: null },
        { id: "f2", location_id: "L2", status: "handover_ready", handed_over_at: null },
        { id: "f3", location_id: "L3", status: "handed_over", handed_over_at: "2026-10-07T12:00:00Z" },
        { id: "f4", location_id: "L4", status: "picked", handed_over_at: null },
      ],
      storeName: (id) => `店${id}`,
      refundActive: false,
      shortageFulfillmentIds: ["f4"],
    });
    assert.deepEqual(rows.map((r) => r.status), ["preparing", "ready", "redeemed", "blocked"]);
    assert.equal(rows[2].redeemed_at, "2026-10-07T12:00:00Z");
    const json = JSON.stringify(rows);
    assert.doesNotMatch(json, /code|qr|token/);
    assert.deepEqual(buildPickupListProjection({ order: { fulfillment_method: "shipping", payment_status: "paid", order_status: "processing" }, fulfillments: [], storeName: () => null, refundActive: false, shortageFulfillmentIds: [] }), []);
  });
});

describe("pickup hardening", () => {
  test("after_sale orders are blocked in both detail and list without refund/shortage rows", async () => {
    const { buildPickupListProjection } = await import("./pickup-view");
    const [p] = buildCustomerPickups({ ...base, order: { ...base.order, order_status: "after_sale" } });
    assert.equal(p.status, "blocked");
    assert.equal(p.code, null);
    const [l] = buildPickupListProjection({
      order: { fulfillment_method: "pickup", payment_status: "paid", order_status: "after_sale" },
      fulfillments: [{ id: "f1", location_id: "L1", status: "handover_ready", handed_over_at: null }],
      storeName: () => null, refundActive: false, shortageFulfillmentIds: [],
    });
    assert.equal(l.status, "blocked");
  });
  test("pickup contact phone comes only from the verified account phone", async () => {
    const { pickupContactPhone } = await import("./pickup-view");
    assert.equal(pickupContactPhone("13800138000"), "13800138000");
    assert.equal(pickupContactPhone("+8613800138000"), "+8613800138000");
    assert.equal(pickupContactPhone(null), null);
    assert.equal(pickupContactPhone(""), null);
    assert.equal(pickupContactPhone("not-a-phone"), null);
  });
});
