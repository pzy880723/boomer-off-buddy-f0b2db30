import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { presentMembershipAccount, presentMembershipPlan } from "./membership-presenter";

describe("membership API presenters", () => {
  test("presents an explorer account using ERP-computed values", () => {
    assert.deepEqual(
      presentMembershipAccount({
        plan: {
          tier_code: "explorer",
          daily_recognition_limit: 30,
          official_discount_rate: 0.95,
          points_multiplier: 1.2,
          points_redemption_cap_rate: 0.15,
          policy_version: 1,
        },
        entitlement: {
          expires_at: "2027-08-17T00:00:00.000Z",
          auto_renew: true,
          source: "apple",
        },
        usage: { used: 7, allowance: 30 },
        pointsBalance: 1280,
        couponCount: 3,
      }),
      {
        tier: {
          code: "explorer",
          name: "探索会员",
          is_paid: true,
          benefits: {
            recognition_daily_limit: 30,
            official_discount_rate: 0.95,
            points_multiplier: 1.2,
            points_order_cap_rate: 0.15,
            can_sell: false,
          },
        },
        recognition: { used: 7, daily_limit: 30, remaining: 23 },
        points: { balance: 1280 },
        coupon_count: 3,
        can_sell: false,
        expires_at: "2027-08-17T00:00:00.000Z",
        auto_renew: true,
        platform: "ios",
        policy_version: 1,
      },
    );
  });

  test("presents an ERP plan in the existing App DTO", () => {
    assert.deepEqual(
      presentMembershipPlan(
        {
          id: "plan-id",
          code: "explorer_annual",
          tier_code: "explorer",
          billing_period: "annual",
          amount_fen: 9900,
          renewal_amount_fen: 9900,
          daily_recognition_limit: 30,
          official_discount_rate: 0.95,
          points_multiplier: 1.2,
          points_redemption_cap_rate: 0.15,
        },
        "ios",
      ),
      {
        id: "plan-id",
        code: "explorer_annual",
        tier_code: "explorer",
        platform: "ios",
        billing_period: "annual",
        price_fen: 9900,
        renewal_price_fen: 9900,
        savings_fen: 12980,
        monthly_average_fen: 825,
        benefits: {
          recognition_daily_limit: 30,
          official_discount_rate: 0.95,
          points_multiplier: 1.2,
          points_order_cap_rate: 0.15,
          can_sell: false,
        },
      },
    );
  });
});
