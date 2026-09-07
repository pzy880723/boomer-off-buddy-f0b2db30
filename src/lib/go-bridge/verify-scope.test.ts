import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGoVerifyPayload,
  resolveErpStoreLocation,
  type GoShopMapping,
} from "./verify-scope";
import { GoScopeError } from "./scope";

const DATE = "2026-09-07";
const ERP_ID = "11111111-1111-4111-8111-111111111111";

function expectError(fn: () => unknown, code: string, status?: number) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GoScopeError, `expected GoScopeError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (status) assert.equal(e.status, status);
    return;
  }
  assert.fail(`expected throw ${code}`);
}

describe("normalizeGoVerifyPayload", () => {
  it("rejects a missing / non-object payload as unavailable (never as 'no data')", () => {
    expectError(() => normalizeGoVerifyPayload(null, DATE), "go_scope_unavailable", 503);
    expectError(() => normalizeGoVerifyPayload("nope", DATE), "go_scope_unavailable", 503);
  });

  it("rejects a payload without a trusted erp_user_id (never guesses by email/phone)", () => {
    expectError(
      () => normalizeGoVerifyPayload({ scope: "store", today: DATE }, DATE),
      "go_identity_not_linked",
      403,
    );
    expectError(
      () => normalizeGoVerifyPayload({ erp_user_id: "not-a-uuid", today: DATE }, DATE),
      "go_identity_not_linked",
      403,
    );
  });

  it("rejects when the GO scope is for another business day", () => {
    expectError(
      () =>
        normalizeGoVerifyPayload(
          { erp_user_id: ERP_ID, scope: "store", today: "2026-09-06", effective_shop_id: "s1" },
          DATE,
        ),
      "go_scope_date_mismatch",
      409,
    );
  });

  it("accepts an HQ scope with no shop of the day", () => {
    const r = normalizeGoVerifyPayload({ erp_user_id: ERP_ID, scope: "hq", today: DATE }, DATE);
    assert.equal(r.scope, "hq");
    assert.equal(r.goShopId, null);
    assert.equal(r.erpUserId, ERP_ID);
  });

  it("maps an explicit rest day to 'off', not to 'no schedule'", () => {
    const r = normalizeGoVerifyPayload(
      { erp_user_id: ERP_ID, scope: "store", today: DATE, schedule_state: "rest" },
      DATE,
    );
    assert.equal(r.scheduleState, "off");
    assert.equal(r.goShopId, null);
  });

  it("keeps 'no_schedule' distinct from 'off'", () => {
    const r = normalizeGoVerifyPayload(
      { erp_user_id: ERP_ID, scope: "store", today: DATE, schedule_state: "no_schedule" },
      DATE,
    );
    assert.equal(r.scheduleState, "no_schedule");
  });

  it("does not invent a state when GO reports neither state nor shop", () => {
    const r = normalizeGoVerifyPayload({ erp_user_id: ERP_ID, scope: "store", today: DATE }, DATE);
    assert.equal(r.scheduleState, "unavailable");
    assert.ok(r.reasons.includes("go_schedule_state_unknown"));
  });

  it("reads the effective shop from any of the documented shapes", () => {
    const a = normalizeGoVerifyPayload(
      { erp_user_id: ERP_ID, scope: "store", today: DATE, effective_shop: { id: "shop-a" } },
      DATE,
    );
    assert.equal(a.scheduleState, "scheduled");
    assert.equal(a.goShopId, "shop-a");
    const b = normalizeGoVerifyPayload(
      { erp_user_id: ERP_ID, scope: "store", date: DATE, effective_shop_id: "shop-b" },
      DATE,
    );
    assert.equal(b.goShopId, "shop-b");
  });

  it("unwraps a single-row RPC array result", () => {
    const r = normalizeGoVerifyPayload([{ erp_user_id: ERP_ID, scope: "hq", today: DATE }], DATE);
    assert.equal(r.scope, "hq");
  });
});

describe("resolveErpStoreLocation", () => {
  const LOC = "22222222-2222-4222-8222-222222222222";
  const mapping: GoShopMapping = { location_id: LOC, status: "active" };

  it("resolves an active, mapped, permitted shop", () => {
    const id = resolveErpStoreLocation({
      goShopId: "shop-a",
      mapping,
      activeShopIds: [LOC],
      permittedLocationIds: [LOC],
    });
    assert.equal(id, LOC);
  });

  it("refuses when the GO shop has no active ERP mapping", () => {
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "shop-a",
          mapping: null,
          activeShopIds: [LOC],
          permittedLocationIds: [LOC],
        }),
      "shop_mapping_missing",
      503,
    );
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "shop-a",
          mapping: { location_id: LOC, status: "revoked" },
          activeShopIds: [LOC],
          permittedLocationIds: [LOC],
        }),
      "shop_mapping_missing",
      503,
    );
  });

  it("refuses a mapped location that is not a real active shop", () => {
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "shop-a",
          mapping,
          activeShopIds: [],
          permittedLocationIds: [LOC],
        }),
      "location_inactive",
      403,
    );
  });

  it("refuses immediately once the ERP store permission is revoked", () => {
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "shop-a",
          mapping,
          activeShopIds: [LOC],
          permittedLocationIds: [],
        }),
      "location_permission_revoked",
      403,
    );
  });
});
