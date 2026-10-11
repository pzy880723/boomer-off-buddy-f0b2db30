import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildCustomerPickups, parsePickupInput, pickupResultMessage, pickupCreateGuard, buildPickupListProjection } from "./pickup-view";

const L1 = "a0000000-0000-4000-8000-000000000001";
const base = {
  order: { fulfillment_method: "pickup", payment_status: "paid", order_status: "processing" },
  fulfillments: [{ id: "f1", location_id: L1, status: "allocated", store_name: "新天地店", store_address: "上海市" }],
  codes: [{ fulfillment_id: "f1", code: "0042", qr_token: "a".repeat(64), status: "active", redeemed_at: null }],
  eligibility: new Map<string, string | null>([["f1", null]]) as ReadonlyMap<string, string | null> | null,
};

describe("customer pickup credentials", () => {
  test("paid & preparing returns 4-digit code with leading zero and QR payload", () => {
    const [p] = buildCustomerPickups(base);
    assert.deepEqual(p, { fulfillment_id: "f1", location_id: L1, store_name: "新天地店", store_address: "上海市",
      status: "preparing", code: "0042", qr_payload: `BOOMER_PICKUP:${"a".repeat(64)}`, redeemed_at: null,
      settlement_eligible: true, block_reason: null });
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
      { ...base, order: { ...base.order, payment_status: "refund_pending" }, eligibility: new Map([["f1", "refund_blocked"]]) },
      { ...base, order: { ...base.order, payment_status: "refunded", order_status: "closed" } },
      { ...base, order: { ...base.order, order_status: "cancelled" } },
      { ...base, eligibility: new Map([["f1", "refund_blocked"]]) },
      { ...base, eligibility: new Map([["f1", "shortage_blocked"]]) },
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
      eligibility: new Map([["f1", null], ["f2", null], ["f3", null], ["f4", "shortage_blocked"]]),
    });
    assert.deepEqual(rows.map((r) => r.status), ["preparing", "ready", "redeemed", "blocked"]);
    assert.equal(rows[2].redeemed_at, "2026-10-07T12:00:00Z");
    const json = JSON.stringify(rows);
    assert.doesNotMatch(json, /code|qr|token/);
    assert.deepEqual(buildPickupListProjection({ order: { fulfillment_method: "shipping", payment_status: "paid", order_status: "processing" }, fulfillments: [], storeName: () => null, eligibility: new Map() }), []);
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
      storeName: () => null, eligibility: new Map([["f1", null]]),
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

test("白名单外子单状态（exception/unknown）不给凭证", () => {
  for (const st of ["exception", "weird"]) {
    const r = buildCustomerPickups({ order: { fulfillment_method: "pickup", payment_status: "paid", order_status: "paid" },
      fulfillments: [{ id: "f", location_id: "l", status: st, store_name: null, store_address: null }],
      codes: [{ fulfillment_id: "f", code: "0123", qr_token: "a".repeat(64), status: "active", redeemed_at: null }],
      eligibility: new Map() });
    assert.equal(r[0].status, "blocked"); assert.equal(r[0].code, null); assert.equal(r[0].qr_payload, null);
    const l = buildPickupListProjection({ order: { fulfillment_method: "pickup", payment_status: "paid", order_status: "paid" },
      fulfillments: [{ id: "f", location_id: "l", status: st, handed_over_at: null }], storeName: () => null,
      eligibility: new Map() });
    assert.equal(l[0].status, "blocked");
  }
});

describe("server-authoritative settlement eligibility", () => {
  const partial = { ...base, order: { ...base.order, payment_status: "partially_refunded" } };
  test("合法部分退款（缺货已清算剩余）：DB 资格通过才给 4 位码/二维码", () => {
    const [p] = buildCustomerPickups(partial);
    assert.equal(p.settlement_eligible, true); assert.equal(p.block_reason, null);
    assert.equal(p.code, "0042"); assert.ok(p.qr_payload);
    const [l] = buildPickupListProjection({ order: partial.order, fulfillments: [{ id: "f1", location_id: L1, status: "allocated", handed_over_at: null }],
      storeName: () => null, eligibility: partial.eligibility });
    assert.equal(l.status, "preparing"); assert.equal(l.settlement_eligible, true);
    assert.doesNotMatch(JSON.stringify(l), /0042|BOOMER_PICKUP|qr_|"code"/);
  });
  test("非法部分退款（非缺货退款/未结清/伪造字符串）：partially_refunded 本身不放行", () => {
    for (const reason of ["refund_blocked", "after_sale_blocked"]) {
      const [p] = buildCustomerPickups({ ...partial, eligibility: new Map([["f1", reason]]) });
      assert.equal(p.status, "blocked"); assert.equal(p.code, null); assert.equal(p.qr_payload, null);
      assert.equal(p.settlement_eligible, false); assert.equal(p.block_reason, reason);
    }
  });
  test("资格查询失败或子单缺失：失败关闭，不输出凭证", () => {
    for (const eligibility of [null, new Map<string, string | null>()]) {
      const [p] = buildCustomerPickups({ ...base, eligibility });
      assert.equal(p.status, "blocked"); assert.equal(p.code, null); assert.equal(p.qr_payload, null);
      assert.equal(p.settlement_eligible, false); assert.equal(p.block_reason, "unavailable");
      const [l] = buildPickupListProjection({ order: base.order, fulfillments: [{ id: "f1", location_id: L1, status: "allocated", handed_over_at: null }],
        storeName: () => null, eligibility });
      assert.equal(l.status, "blocked");
    }
  });
});
