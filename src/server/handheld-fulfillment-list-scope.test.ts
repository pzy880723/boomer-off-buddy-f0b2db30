import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveFulfillmentListScope } from "@/server/handheld-fulfillment-access.server";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("fulfillments list scope", () => {
  it("HQ 按目标门店筛选返回 location:<id>", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: true,
        wantsAll: false,
        deviceLocationId: DEVICE,
        requestedLocationId: OTHER,
        hqCanAccessRequested: true,
      }),
      { ok: true, scope: `location:${OTHER}`, locationId: OTHER },
    );
  });

  it("HQ 未筛选且 scope=all 返回 all", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: true,
        wantsAll: true,
        deviceLocationId: DEVICE,
        requestedLocationId: null,
      }),
      { ok: true, scope: "all", locationId: null },
    );
  });

  it("HQ 同时传 scope=all 与 location_id 时以门店筛选为准", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: true,
        wantsAll: true,
        deviceLocationId: DEVICE,
        requestedLocationId: OTHER,
        hqCanAccessRequested: true,
      }),
      { ok: true, scope: `location:${OTHER}`, locationId: OTHER },
    );
  });

  it("HQ 对未授权门店返回 403", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: true,
        wantsAll: false,
        deviceLocationId: DEVICE,
        requestedLocationId: OTHER,
        hqCanAccessRequested: false,
      }),
      { ok: false, code: "location_forbidden" },
    );
  });

  it("普通员工固定当前设备授权库位", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: false,
        wantsAll: false,
        deviceLocationId: DEVICE,
        requestedLocationId: null,
      }),
      { ok: true, scope: `location:${DEVICE}`, locationId: DEVICE },
    );
  });

  it("普通员工传不匹配门店必须 403，不静默换 scope", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: false,
        wantsAll: false,
        deviceLocationId: DEVICE,
        requestedLocationId: OTHER,
      }),
      { ok: false, code: "location_forbidden" },
    );
  });

  it("普通员工请求 scope=all 返回 hq_required", () => {
    assert.deepEqual(
      resolveFulfillmentListScope({
        isHq: false,
        wantsAll: true,
        deviceLocationId: DEVICE,
        requestedLocationId: null,
      }),
      { ok: false, code: "hq_required" },
    );
  });
});
