import test from "node:test";
import assert from "node:assert/strict";
import { nextAction, reasonLabel, resolveSyncLocations, statusLabel } from "@/server/handheld-sync-records";
import type { NotificationScope } from "@/server/handheld-notifications.server";

const WH = "5c000000-0000-4000-8000-0000000000aa";
const A = "5c000000-0000-4000-8000-00000000000a";
const B = "5c000000-0000-4000-8000-00000000000b";
const kinds: Record<string, "warehouse" | "shop"> = { [WH]: "warehouse", [A]: "shop", [B]: "shop" };
const kindOf = (id: string) => kinds[id] ?? null;
const staff: NotificationScope = { user_id: "u", device_id: "d", device_location_id: A, location_ids: [A], is_hq: false };
const hq: NotificationScope = { ...staff, device_location_id: WH, location_ids: [WH, A, B], is_hq: true };

test("普通店员只看本店，请求他店 403", () => {
  assert.deepEqual(resolveSyncLocations(staff, null, kindOf), { ok: true, locationIds: [A], current: A });
  assert.deepEqual(resolveSyncLocations(staff, B, kindOf), { ok: false, status: 403, code: "location_forbidden" });
  assert.deepEqual(resolveSyncLocations(staff, "x", kindOf), { ok: false, status: 400, code: "validation_error" });
});
test("旧客户端省略 location_id 用设备库位；无库位 400", () => {
  assert.deepEqual(resolveSyncLocations({ ...staff, device_location_id: null }, null, kindOf), { ok: false, status: 400, code: "location_required" });
});
test("总部账号切到门店只看本店；仅总部仓位看全部授权库位", () => {
  assert.deepEqual(resolveSyncLocations(hq, B, kindOf), { ok: true, locationIds: [B], current: B });
  assert.deepEqual(resolveSyncLocations(hq, null, kindOf), { ok: true, locationIds: [WH, A, B], current: WH });
  const staffWh = { ...staff, device_location_id: WH, location_ids: [WH] };
  assert.deepEqual(resolveSyncLocations(staffWh, null, kindOf), { ok: true, locationIds: [WH], current: WH });
});
test("中文状态/原因/下一步，不回显内部编码", () => {
  assert.equal(statusLabel("done"), "同步任务已结束");
  assert.equal(statusLabel("weird_x"), "状态未知");
  assert.equal(reasonLabel("meiluo_standard_warehouse_verified"), "美罗城标准商品库存单核对");
  assert.equal(reasonLabel("offline_product_release"), "商品发布到门店");
  assert.equal(reasonLabel("sale:other_x"), "售出后同步");
  assert.equal(reasonLabel("unknown_code_y"), "其他同步");
  assert.equal(nextAction("failed"), "系统会自动重试；多次仍失败请联系总部");
  for (const s of [statusLabel("zz_q"), reasonLabel("zz_q"), nextAction("zz_q")]) assert.doesNotMatch(s, /[a-z_]{3,}/);
});
import { errorLabel } from "@/server/handheld-sync-records";
test("失败原因中文呈现；done 下一步不绝对", () => {
  assert.equal(nextAction("done"), "任务已结束；若有赞库存仍异常，请总部核对");
  assert.equal(errorLabel(null), null);
  assert.equal(errorLabel("开启了进出存单据管理库存，修改库存不会生效"), "门店开启了库存单管理，需库存单核对");
  assert.equal(errorLabel("商品尚未发布到目标门店，请重试"), "商品尚未发布到该门店，请先等发布完成");
  assert.equal(errorLabel("HTTP 500 upstream timeout"), "同步出错，请总部核对技术记录");
});
