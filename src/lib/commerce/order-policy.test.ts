import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canTransitionFulfillment,
  checkoutHoldExpiresAt,
  deriveOrderStatus,
  normalizeCourierChoice,
} from "./order-policy";

describe("commerce order policy", () => {
  test("checkout reservations expire after fifteen minutes", () => {
    const now = new Date("2026-07-13T00:00:00.000Z");
    assert.equal(checkoutHoldExpiresAt(now).toISOString(), "2026-07-13T00:15:00.000Z");
  });

  test("fulfillment cannot skip picking and packing gates", () => {
    assert.equal(canTransitionFulfillment("allocated", "picking"), true);
    assert.equal(canTransitionFulfillment("allocated", "packed"), false);
    assert.equal(canTransitionFulfillment("picked", "packing"), true);
    assert.equal(canTransitionFulfillment("packing", "packed"), true);
  });

  test("paid active orders are processing until fulfillment completes", () => {
    assert.equal(deriveOrderStatus("paid", ["allocated", "packed"]), "processing");
    assert.equal(deriveOrderStatus("paid", ["handed_over", "handed_over"]), "completed");
    assert.equal(deriveOrderStatus("refunded", ["handed_over"]), "closed");
  });

  test("courier choice is snapshotted to supported service codes", () => {
    assert.deepEqual(normalizeCourierChoice("SF_STANDARD"), {
      provider: "sf",
      serviceCode: "SF_STANDARD",
    });
    assert.deepEqual(normalizeCourierChoice("CAINIAO_RECOMMENDED"), {
      provider: "cainiao",
      serviceCode: "CAINIAO_RECOMMENDED",
    });
    assert.deepEqual(normalizeCourierChoice("platform_recommended"), {
      provider: "platform",
      serviceCode: "PLATFORM_RECOMMENDED",
    });
  });
});
