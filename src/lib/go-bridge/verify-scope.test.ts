import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoVerifyPayload, resolveErpStoreLocation, type GoShopMapping } from "./verify-scope";
import { GoScopeError } from "./scope";

const DATE = "2026-09-07";
const GO_UID = "99999999-9999-4999-8999-999999999999";
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

/** GO b9eaad54 的真实返回结构 */
function payload(over: {
  scope?: string;
  status?: string;
  effective_shop?: { id: string; name: string } | null;
  authorized_shops?: { id: string; name: string }[];
  date?: string;
  shopScope?: string;
  authenticated?: boolean;
  user_id?: string;
  erp_user_id?: unknown;
  is_erp_user?: boolean;
}) {
  const scope = over.scope ?? "store";
  return {
    authenticated: over.authenticated ?? true,
    user_id: over.user_id ?? GO_UID,
    erp_user_id: "erp_user_id" in over ? over.erp_user_id : ERP_ID,
    is_erp_user: over.is_erp_user ?? true,
    scope_context: {
      scope,
      shop_ids: (over.authorized_shops ?? []).map((s) => s.id),
      role_codes: ["store_staff"],
      erp_linked: true,
      erp_governed: true,
    },
    shop_context: {
      date: over.date ?? DATE,
      scope: over.shopScope ?? scope,
      status: over.status ?? "scheduled",
      effective_shop: over.effective_shop ?? null,
      authorized_shops: over.authorized_shops ?? [],
      self_schedule: null,
    },
  };
}

const opts = { expectedDate: DATE, expectedGoUserId: GO_UID };

describe("parseGoVerifyPayload (real nested contract)", () => {
  it("refuses non-object payloads instead of inventing a state", () => {
    expectError(() => parseGoVerifyPayload(null, opts), "go_scope_unavailable", 503);
    expectError(() => parseGoVerifyPayload("nope", opts), "go_scope_unavailable", 503);
  });

  it("refuses when GO reports authenticated=false", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ authenticated: false }), opts),
      "invalid_go_token",
      401,
    );
  });

  it("refuses when GO user_id differs from the verified auth.getUser id", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ user_id: ERP_ID }), opts),
      "go_identity_mismatch",
      403,
    );
  });

  it("separates 'not an ERP user' from 'GO has not returned erp_user_id yet'", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ is_erp_user: false }), opts),
      "go_identity_not_linked",
      403,
    );
    // GO 补丁未部署 / 字段缺失：fail closed，且不得回退 email 或 metadata 猜 ID
    expectError(
      () => parseGoVerifyPayload(payload({ erp_user_id: undefined }), opts),
      "go_erp_user_id_unavailable",
      503,
    );
    expectError(
      () => parseGoVerifyPayload(payload({ erp_user_id: "nope" }), opts),
      "go_erp_user_id_unavailable",
      503,
    );
    expectError(
      () => parseGoVerifyPayload(payload({ erp_user_id: "staff@example.com" }), opts),
      "go_erp_user_id_unavailable",
      503,
    );
  });


  it("refuses an unconfigured scope instead of silently treating it as no-schedule", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ scope: "unconfigured", status: "unconfigured" }), opts),
      "go_scope_unconfigured",
      403,
    );
  });

  it("never defaults a missing shop_context.date to today", () => {
    const raw = payload({}) as unknown as { shop_context: Record<string, unknown> };
    delete raw.shop_context["date"];
    expectError(() => parseGoVerifyPayload(raw, opts), "go_scope_unavailable", 503);
  });

  it("refuses a cross-day context", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ date: "2026-09-06" }), opts),
      "go_scope_date_mismatch",
      409,
    );
  });

  it("flags an inconsistent scope_context / shop_context as a stale context", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ scope: "store", shopScope: "hq" }), opts),
      "go_scope_stale",
      409,
    );
  });

  it("parses an HQ actor", () => {
    const r = parseGoVerifyPayload(payload({ scope: "hq", status: "hq" }), opts);
    assert.equal(r.scope, "hq");
    assert.equal(r.status, "hq");
    assert.equal(r.scheduleState, "scheduled");
    assert.equal(r.effectiveShop, null);
    assert.equal(r.erpUserId, ERP_ID);
  });

  it("parses a scheduled staff member with the single effective GO shop", () => {
    const r = parseGoVerifyPayload(
      payload({
        status: "scheduled",
        effective_shop: { id: "go-shop-1", name: "中信泰富店" },
        authorized_shops: [{ id: "go-shop-1", name: "中信泰富店" }],
      }),
      opts,
    );
    assert.equal(r.scheduleState, "scheduled");
    assert.deepEqual(r.effectiveShop, { id: "go-shop-1", name: "中信泰富店" });
    assert.equal(r.authorizedShops.length, 1);
  });

  it("maps rest and unscheduled to distinct states, never to each other", () => {
    assert.equal(parseGoVerifyPayload(payload({ status: "rest" }), opts).scheduleState, "off");
    assert.equal(
      parseGoVerifyPayload(payload({ status: "unscheduled" }), opts).scheduleState,
      "no_schedule",
    );
  });

  it("refuses scheduled without an effective shop", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ status: "scheduled" }), opts),
      "go_schedule_missing_shop",
      503,
    );
  });

  it("refuses an unknown status rather than guessing", () => {
    expectError(
      () => parseGoVerifyPayload(payload({ status: "on_duty" }), opts),
      "go_scope_unavailable",
      503,
    );
  });

  it("rejects the old flat shape (no silent alias compatibility)", () => {
    expectError(
      () =>
        parseGoVerifyPayload(
          { erp_user_id: ERP_ID, scope: "store", today: DATE, effective_shop_id: "s1" },
          opts,
        ),
      "go_scope_unavailable",
      503,
    );
  });

  it("unwraps a single-row RPC array result", () => {
    const r = parseGoVerifyPayload([payload({ scope: "hq", status: "hq" })], opts);
    assert.equal(r.scope, "hq");
  });
});

describe("resolveErpStoreLocation", () => {
  const LOC = "22222222-2222-4222-8222-222222222222";
  const mapping: GoShopMapping = { location_id: LOC, status: "active" };

  it("resolves an active, mapped, permitted shop", () => {
    assert.equal(
      resolveErpStoreLocation({
        goShopId: "go-shop-1",
        mapping,
        activeShopIds: [LOC],
        permittedLocationIds: [LOC],
      }),
      LOC,
    );
  });

  it("refuses when the GO shop has no active ERP mapping (never guesses by name)", () => {
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "go-shop-1",
          mapping: null,
          activeShopIds: [LOC],
          permittedLocationIds: [LOC],
        }),
      "shop_mapping_unconfigured",
      503,
    );
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "go-shop-1",
          mapping: { location_id: LOC, status: "revoked" },
          activeShopIds: [LOC],
          permittedLocationIds: [LOC],
        }),
      "shop_mapping_unconfigured",
      503,
    );
  });

  it("refuses a mapped location that is not a real active shop", () => {
    expectError(
      () =>
        resolveErpStoreLocation({
          goShopId: "go-shop-1",
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
          goShopId: "go-shop-1",
          mapping,
          activeShopIds: [LOC],
          permittedLocationIds: [],
        }),
      "location_permission_revoked",
      403,
    );
  });
});
