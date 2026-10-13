import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRequestedLocation, buildVisibilityFilter, effectiveLocationIds, type NotificationScope } from "@/server/handheld-notifications.server";

const A = "5c000000-0000-4000-8000-00000000000a";
const B = "5c000000-0000-4000-8000-00000000000b";
const C = "5c000000-0000-4000-8000-00000000000c";
const staff: NotificationScope = { user_id: "u1", device_id: "d1", device_location_id: A, location_ids: [A, B], is_hq: false };

describe("手持通知门店范围", () => {
  it("显式 location_id 必须在授权范围内；普通员工不能伪造他店/总部", () => {
    assert.deepEqual(applyRequestedLocation(staff, C), { ok: false, code: "location_forbidden" });
    assert.deepEqual(applyRequestedLocation(staff, "not-a-uuid"), { ok: false, code: "validation_error" });
    const r = applyRequestedLocation(staff, A);
    assert.ok(r.ok); assert.deepEqual(effectiveLocationIds(r.scope), [A]);
    assert.equal(applyRequestedLocation(staff, null).ok, true);
  });
  it("总部可显式选择任一启用门店", () => {
    const hq = { ...staff, is_hq: true, location_ids: [A, B, C] };
    const r = applyRequestedLocation(hq, C); assert.ok(r.ok); assert.deepEqual(effectiveLocationIds(r.scope), [C]);
  });
  it("过滤串在查询层同时限定门店与收件人，定向他人/他设备的同店通知不匹配", () => {
    const r = applyRequestedLocation(staff, A); assert.ok(r.ok);
    const f = buildVisibilityFilter(r.scope);
    assert.equal(f, `and(or(location_id.is.null,location_id.in.(${A})),or(user_id.eq.u1,and(user_id.is.null,device_id.is.null),and(user_id.is.null,device_id.eq.d1)))`);
    assert.doesNotMatch(f, new RegExp(B));
    // 不再有“仅凭门店即可见”的独立分支
    assert.doesNotMatch(f, /^location_id\.in|,location_id\.in\.\([^)]*\)(,|$)(?!.*user_id)/);
  });
});
