import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  chooseBestBenefit,
  membershipPolicyForTier,
  pointsDiscountLimitFen,
} from "./membership-policy";

describe("BOOMER membership policy", () => {
  test("free members receive five daily recognitions and no discount", () => {
    const policy = membershipPolicyForTier("free");
    assert.equal(policy.dailyRecognitionLimit, 5);
    assert.equal(policy.officialDiscountRate, 1);
    assert.equal(policy.pointsMultiplier, 1);
    assert.equal(policy.pointsRedemptionCapRate, 0);
  });

  test("explorer members receive the approved paid benefits", () => {
    const policy = membershipPolicyForTier("explorer");
    assert.equal(policy.dailyRecognitionLimit, 30);
    assert.equal(policy.officialDiscountRate, 0.95);
    assert.equal(policy.pointsMultiplier, 1.2);
    assert.equal(policy.pointsRedemptionCapRate, 0.15);
  });

  test("points redemption is capped at fifteen percent for explorer", () => {
    assert.equal(pointsDiscountLimitFen(10_000, "explorer"), 1_500);
    assert.equal(pointsDiscountLimitFen(10_000, "free"), 0);
  });

  test("coupon and member discount do not stack and the better saving wins", () => {
    assert.deepEqual(
      chooseBestBenefit({ subtotalFen: 20_000, tier: "explorer", couponSavingFen: 1_500 }),
      { kind: "coupon", savingFen: 1_500 },
    );
    assert.deepEqual(
      chooseBestBenefit({ subtotalFen: 20_000, tier: "explorer", couponSavingFen: 500 }),
      { kind: "member_discount", savingFen: 1_000 },
    );
  });
});
