import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildVisibilityFilter, describeScope } from "@/server/handheld-notifications.server";
import { FULFILLMENT_QR_PREFIX, parseFulfillmentCode } from "@/server/handheld-fulfillment.server";
import { staffCanAccessConversation, type SupportAccess } from "@/server/support.server";

const hqAccess: SupportAccess = {
  user_id: "u-hq",
  display_name: "总部客服",
  is_hq_agent: true,
  location_ids: [],
  participant_role: "hq_agent",
};
const storeAccess: SupportAccess = {
  user_id: "u-store",
  display_name: "门店客服",
  is_hq_agent: false,
  location_ids: ["loc-a"],
  participant_role: "store_staff",
};

describe("消息可见范围", () => {
  it("包含本人、本设备与全局广播", () => {
    const filter = buildVisibilityFilter({
      user_id: "u1",
      device_id: "d1",
      device_location_id: null,
      location_ids: [],
      is_hq: false,
    });
    assert.match(filter, /user_id\.eq\.u1/);
    assert.match(filter, /device_id\.eq\.d1/);
    assert.match(filter, /and\(user_id\.is\.null,device_id\.is\.null,location_id\.is\.null\)/);
    assert.ok(!filter.includes("location_id.in."));
  });

  it("有授权库位时才追加库位过滤", () => {
    const filter = buildVisibilityFilter({
      user_id: "u1",
      device_id: "d1",
      device_location_id: "loc-a",
      location_ids: ["loc-a", "loc-b"],
      is_hq: false,
    });
    assert.match(filter, /location_id\.in\.\(loc-a,loc-b\)/);
  });

  it("scope 描述区分总部与门店", () => {
    assert.equal(
      describeScope({
        user_id: "u",
        device_id: "d",
        device_location_id: null,
        location_ids: [],
        is_hq: true,
      }),
      "hq_all_locations",
    );
    assert.equal(
      describeScope({
        user_id: "u",
        device_id: "d",
        device_location_id: null,
        location_ids: [],
        is_hq: false,
      }),
      "personal_only",
    );
  });
});

describe("订单码解析", () => {
  it("接受固定命名空间二维码", () => {
    const parsed = parseFulfillmentCode(
      `${FULFILLMENT_QR_PREFIX}11111111-2222-4333-8444-555555555555`,
    );
    assert.deepEqual(parsed, { kind: "id", value: "11111111-2222-4333-8444-555555555555" });
  });

  it("接受真实履约单号", () => {
    assert.deepEqual(parseFulfillmentCode("FUL-20260906-0001"), {
      kind: "code",
      value: "FUL-20260906-0001",
    });
  });

  it("拒绝任意 URL 与其它命名空间", () => {
    assert.equal(parseFulfillmentCode("https://evil.example.com/x"), null);
    assert.equal(parseFulfillmentCode("boomer-erp:fulfillment:not-a-uuid"), null);
    assert.equal(parseFulfillmentCode("weixin://scan"), null);
    assert.equal(parseFulfillmentCode(""), null);
  });
});

describe("客服会话授权", () => {
  it("总部客服可进入任何门店会话", () => {
    assert.equal(staffCanAccessConversation(hqAccess, { location_id: "loc-z" }), true);
  });

  it("门店客服只能进入本店会话", () => {
    assert.equal(staffCanAccessConversation(storeAccess, { location_id: "loc-a" }), true);
    assert.equal(staffCanAccessConversation(storeAccess, { location_id: "loc-b" }), false);
    assert.equal(staffCanAccessConversation(storeAccess, { location_id: null }), false);
  });

  it("同一会话总部与门店可同时接待（无独占）", () => {
    const conversation = { location_id: "loc-a" };
    assert.equal(staffCanAccessConversation(hqAccess, conversation), true);
    assert.equal(staffCanAccessConversation(storeAccess, conversation), true);
  });
});
