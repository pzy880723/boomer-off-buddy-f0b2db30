import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";

const presenterUrl = new URL("./membership-admin-presenter.ts", import.meta.url);

describe("membership admin presenter", () => {
  test("presents paid member operations data and masks the phone", async () => {
    assert.equal(existsSync(presenterUrl), true, "会员后台 presenter 尚未创建");
    const { presentMembershipAdminRow } = await import(presenterUrl.href);

    assert.deepEqual(
      presentMembershipAdminRow(
        {
          customer: {
            id: "c670d9ee-0000-4000-8000-000000000001",
            external_subject: "consumer-1",
            phone: "13812346219",
            nickname: "陈小满",
            avatar_url: null,
            status: "active",
            created_at: "2026-08-01T00:00:00.000Z",
          },
          entitlement: {
            tier_code: "explorer",
            status: "active",
            starts_at: "2026-08-01T00:00:00.000Z",
            expires_at: "2026-08-27T00:00:00.000Z",
            auto_renew: true,
            source: "apple",
            plan: { code: "explorer_annual", display_name: "探索会员年度会员" },
          },
          usage: { used: 12, allowance: 30 },
          points: 1280,
          couponCount: 3,
          spend90dFen: 198600,
        },
        new Date("2026-08-21T00:00:00.000Z"),
      ),
      {
        id: "c670d9ee-0000-4000-8000-000000000001",
        member_no: "BOC670D9EE",
        phone: "13812346219",
        masked_phone: "138****6219",
        nickname: "陈小满",
        avatar_url: null,
        customer_status: "active",
        tier_code: "explorer",
        tier_name: "探索会员",
        plan_code: "explorer_annual",
        plan_name: "探索会员年度会员",
        entitlement_status: "active",
        expiry_state: "expiring",
        expires_at: "2026-08-27T00:00:00.000Z",
        auto_renew: true,
        source: "apple",
        recognition: { used: 12, allowance: 30, remaining: 18 },
        points: 1280,
        coupon_count: 3,
        spend_90d_fen: 198600,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    );
  });

  test("falls back to the free tier without inventing an entitlement", async () => {
    assert.equal(existsSync(presenterUrl), true, "会员后台 presenter 尚未创建");
    const { presentMembershipAdminRow } = await import(presenterUrl.href);
    const row = presentMembershipAdminRow({
      customer: {
        id: "12345678-0000-4000-8000-000000000002",
        external_subject: "consumer-2",
        phone: null,
        nickname: null,
        avatar_url: null,
        status: "active",
        created_at: "2026-08-01T00:00:00.000Z",
      },
      entitlement: null,
      usage: { used: 5, allowance: 5 },
      points: 0,
      couponCount: 0,
      spend90dFen: 0,
    });

    assert.equal(row.tier_code, "free");
    assert.equal(row.tier_name, "好奇玩家");
    assert.equal(row.expiry_state, "free");
    assert.equal(row.expires_at, null);
    assert.equal(row.masked_phone, "未绑定手机");
    assert.deepEqual(row.recognition, { used: 5, allowance: 5, remaining: 0 });
  });
});
