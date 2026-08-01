import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StorePaymentNotReadyError, buildStorePaymentPlan } from "./store-payment-plan";

const profiles = [
  {
    id: "profile-a",
    locationId: "location-a",
    locationName: "中信泰富店",
    paymentCode: "BO-PAY-ZXTF",
    profileStatus: "active" as const,
    subjectId: "subject-a",
    subjectName: "上海中信泰富门店主体",
    verificationStatus: "approved" as const,
    providerStatus: "active" as const,
    merchantId: "1900000001",
  },
  {
    id: "profile-b",
    locationId: "location-b",
    locationName: "静安店",
    paymentCode: "BO-PAY-JA",
    profileStatus: "active" as const,
    subjectId: "subject-b",
    subjectName: "上海静安门店主体",
    verificationStatus: "approved" as const,
    providerStatus: "active" as const,
    merchantId: "1900000002",
  },
];

describe("store payment allocation plan", () => {
  test("keeps a one-store order on that store's merchant", () => {
    const plan = buildStorePaymentPlan({
      orderId: "order-1",
      totalAmount: 699,
      currency: "CNY",
      items: [{ id: "line-1", locationId: "location-a", lineTotal: 699 }],
      profiles,
    });

    assert.equal(plan.subOrders.length, 1);
    assert.deepEqual(plan.subOrders[0], {
      paymentProfileId: "profile-a",
      settlementSubjectId: "subject-a",
      merchantId: "1900000001",
      paymentCode: "BO-PAY-ZXTF",
      amount: 699,
      lineAmount: 699,
      orderAdjustment: 0,
      locationIds: ["location-a"],
    });
    assert.equal(plan.itemSnapshots[0].settlementSubjectId, "subject-a");
  });

  test("splits a cross-store order and preserves the exact payable total", () => {
    const plan = buildStorePaymentPlan({
      orderId: "order-2",
      totalAmount: 107.01,
      currency: "CNY",
      items: [
        { id: "line-a", locationId: "location-a", lineTotal: 30 },
        { id: "line-b", locationId: "location-b", lineTotal: 70 },
      ],
      profiles,
    });

    assert.equal(plan.subOrders.length, 2);
    assert.deepEqual(
      plan.subOrders.map((entry) => [entry.settlementSubjectId, entry.amount]),
      [
        ["subject-a", 32.1],
        ["subject-b", 74.91],
      ],
    );
    assert.equal(
      plan.subOrders.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0),
      10_701,
    );
  });

  test("rejects stores whose subject or WeChat merchant is not active", () => {
    assert.throws(
      () =>
        buildStorePaymentPlan({
          orderId: "order-3",
          totalAmount: 20,
          currency: "CNY",
          items: [{ id: "line-1", locationId: "location-a", lineTotal: 20 }],
          profiles: [{ ...profiles[0], providerStatus: "applying" }],
        }),
      (error: unknown) =>
        error instanceof StorePaymentNotReadyError &&
        error.code === "store_payment_not_ready" &&
        error.locationIds.includes("location-a"),
    );
  });
});
