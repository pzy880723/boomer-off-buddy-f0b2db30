import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  resolveConversationLocationFilter,
  type SupportAccess,
} from "@/server/support.server";

const hq: SupportAccess = {
  user_id: "u-hq",
  display_name: "HQ",
  is_hq_agent: true,
  location_ids: [],
  participant_role: "hq_agent",
};

const staff: SupportAccess = {
  user_id: "u-staff",
  display_name: "Staff",
  is_hq_agent: false,
  location_ids: ["loc-a"],
  participant_role: "store_staff",
};

describe("support conversation location scope", () => {
  it("HQ 不传 location_id 时表示全部授权门店", () => {
    assert.deepEqual(resolveConversationLocationFilter(hq, null), { ok: true, location_id: null });
    assert.deepEqual(resolveConversationLocationFilter(hq, "  "), { ok: true, location_id: null });
  });

  it("HQ 传门店时按该门店过滤", () => {
    assert.deepEqual(resolveConversationLocationFilter(hq, "loc-b"), {
      ok: true,
      location_id: "loc-b",
    });
  });

  it("分店员工传本店通过", () => {
    assert.deepEqual(resolveConversationLocationFilter(staff, "loc-a"), {
      ok: true,
      location_id: "loc-a",
    });
  });

  it("分店员工传非授权门店被服务端拒绝", () => {
    assert.deepEqual(resolveConversationLocationFilter(staff, "loc-b"), {
      ok: false,
      code: "forbidden_location",
    });
  });

  it("分店员工不传门店仍只落在授权门店范围内", () => {
    assert.deepEqual(resolveConversationLocationFilter(staff, null), {
      ok: true,
      location_id: null,
    });
  });
});
