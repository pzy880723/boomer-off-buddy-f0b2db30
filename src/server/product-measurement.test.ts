/**
 * 商品实测尺寸：申请合并、幂等、权限、版本保护、通知。
 * 纯内存 fake store，不触数据库。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MeasurementStore,
  claimMeasurementTask,
  completeMeasurement,
  createMemoryMeasurementStore,
  requestMeasurement,
  saveMeasurementDiagram,
  validateMeasurementInput,
} from "./product-measurement.server";

function seed(store: MeasurementStore) {
  store.skus.set("sku1", {
    id: "sku1",
    measurement_revision: 0,
    measured_at: null,
  });
  store.listings.set("listing1", {
    id: "listing1",
    sku_id: "sku1",
    location_id: "loc1",
    status: "published",
    published_at: "2026-10-01T00:00:00Z",
  });
}

test("申请测量：同商品多用户合并为一个活跃任务，重复申请幂等", async () => {
  const store = createMemoryMeasurementStore();
  seed(store);
  const a = await requestMeasurement(store, { customerId: "custA", listingId: "listing1" });
  assert.equal(a.status, "pending");
  const b = await requestMeasurement(store, { customerId: "custB", listingId: "listing1" });
  assert.equal(b.task_id, a.task_id, "第二个用户应并入同一任务");
  const a2 = await requestMeasurement(store, { customerId: "custA", listingId: "listing1" });
  assert.equal(a2.task_id, a.task_id, "重复申请返回同一任务");
  assert.equal(store.requesters.get(a.task_id!)!.size, 2, "只记录两个不同申请人");
});

test("已有实测尺寸的商品直接返回 completed，不建任务", async () => {
  const store = createMemoryMeasurementStore();
  seed(store);
  store.skus.get("sku1")!.measured_at = "2026-10-10T00:00:00Z";
  const res = await requestMeasurement(store, { customerId: "custA", listingId: "listing1" });
  assert.equal(res.status, "completed");
  assert.equal(store.tasks.size, 0);
});

test("未发布/草稿商品不允许申请", async () => {
  const store = createMemoryMeasurementStore();
  seed(store);
  store.listings.get("listing1")!.status = "draft";
  await assert.rejects(
    () => requestMeasurement(store, { customerId: "custA", listingId: "listing1" }),
    /not_found/,
  );
});

test("尺寸输入校验：正有限值，null 保留未知，拒绝 0/负数/NaN/Infinity", () => {
  assert.deepEqual(validateMeasurementInput({ height_cm: 12.5, width_cm: null }), {
    ok: true,
    value: { height_cm: 12.5, width_cm: null, depth_cm: null, diameter_cm: null },
  });
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100000]) {
    assert.equal(validateMeasurementInput({ height_cm: bad }).ok, false, `应拒绝 ${bad}`);
  }
});

test("保存实测：门店员工只能录本店，总部可录任意店；完成任务并通知全部申请者", async () => {
  const store = createMemoryMeasurementStore();
  seed(store);
  const req = await requestMeasurement(store, { customerId: "custA", listingId: "listing1" });
  await requestMeasurement(store, { customerId: "custB", listingId: "listing1" });

  // 他店员工被拒
  await assert.rejects(
    () =>
      completeMeasurement(store, {
        taskId: req.task_id!,
        actor: { userId: "staff1", roles: ["store_staff"], locationIds: ["loc2"] },
        input: { height_cm: 10 },
      }),
    /forbidden/,
  );
  // 本店员工成功
  const done = await completeMeasurement(store, {
    taskId: req.task_id!,
    actor: { userId: "staff1", roles: ["store_staff"], locationIds: ["loc1"] },
    input: { height_cm: 10, width_cm: 8 },
  });
  assert.equal(done.revision, 1);
  assert.equal(store.skus.get("sku1")!.measured_by, "staff1");
  assert.equal(store.tasks.get(req.task_id!)!.status, "completed");
  assert.equal(store.notifications.length, 2, "两个申请者都应收到通知");
  // 总部可直接保存（无任务场景）
  const hq = await completeMeasurement(store, {
    skuId: "sku1",
    actor: { userId: "hq1", roles: ["super_admin"], locationIds: [] },
    input: { height_cm: 11 },
    expectedRevision: 1,
  });
  assert.equal(hq.revision, 2);
});

test("版本保护：旧 revision 的尺寸素材不得覆盖新版；失败可重试", async () => {
  const store = createMemoryMeasurementStore();
  seed(store);
  store.skus.get("sku1")!.measurement_revision = 2;
  // 旧 job（revision 1）上报 ready → 拒绝
  await assert.rejects(
    () =>
      saveMeasurementDiagram(store, {
        skuId: "sku1",
        revision: 1,
        status: "ready",
        cutoutPreviewPath: "sku-listing/measurements/sku1-r1.png",
        bbox: { x: 0, y: 0, w: 100, h: 200 },
        frontWidthPx: 100,
        frontHeightPx: 200,
        pxPerCm: 10,
      }),
    /stale_revision/,
  );
  // 当前版本失败 → 记录 failed，可重试
  const failed = await saveMeasurementDiagram(store, {
    skuId: "sku1",
    revision: 2,
    status: "failed",
    error: "segmentation_unavailable",
  });
  assert.equal(failed.status, "failed");
  const ready = await saveMeasurementDiagram(store, {
    skuId: "sku1",
    revision: 2,
    status: "ready",
    cutoutPreviewPath: "sku-listing/measurements/sku1-r2.png",
    bbox: { x: 0, y: 0, w: 100, h: 200 },
    frontWidthPx: 100,
    frontHeightPx: 200,
    pxPerCm: 10,
  });
  assert.equal(ready.status, "ready");
});

test("尺寸素材缺少抠图或几何时不得标 ready", async () => {
  const store = createMemoryMeasurementStore();
  seed(store);
  await assert.rejects(
    () =>
      saveMeasurementDiagram(store, {
        skuId: "sku1",
        revision: 0,
        status: "ready",
        cutoutPreviewPath: null,
        bbox: null,
        frontWidthPx: null,
        frontHeightPx: null,
        pxPerCm: null,
      }),
    /incomplete_asset/,
  );
});

// ---------- 门店归属 = inv_stocks 真实库存 ----------
import {
  measurementLocationAccess,
  resolveEditableLocation,
  actorCanReadSkuMeasurement,
} from "./product-measurement.server";

const staffA = { userId: "a", roles: ["store_staff"], locationIds: ["A"] };
const staffB = { userId: "b", roles: ["store_staff"], locationIds: ["B"] };
const hq = { userId: "h", roles: ["super_admin"], locationIds: [] };

test("A0B1：A 店只读不可改，B 店可改；总部在 A 也不能改", () => {
  const stocks = [{ location_id: "A", qty: 0 }, { location_id: "B", qty: 1 }];
  assert.equal(measurementLocationAccess(staffA, stocks, "A"), "read");
  assert.equal(measurementLocationAccess(staffB, stocks, "B"), "edit");
  assert.equal(measurementLocationAccess(hq, stocks, "A"), "read");
  assert.equal(measurementLocationAccess(staffA, stocks, "B"), "none");
});

test("无库存行的门店：拒绝（不凭空归属）", () => {
  assert.equal(measurementLocationAccess(staffA, [], "A"), "none");
  assert.equal(actorCanReadSkuMeasurement(staffA, [{ location_id: "B", qty: 1 }]), false);
  assert.equal(actorCanReadSkuMeasurement(staffA, [{ location_id: "A", qty: 0 }]), true);
});

test("网页保存门店：唯一有货店自动选；多店有货不随机选；无货拒绝", () => {
  assert.deepEqual(resolveEditableLocation(staffB, [{ location_id: "A", qty: 0 }, { location_id: "B", qty: 1 }], null), { ok: true, locationId: "B" });
  assert.deepEqual(resolveEditableLocation(hq, [{ location_id: "A", qty: 1 }, { location_id: "B", qty: 1 }], null), { ok: false, error: "ambiguous" });
  assert.deepEqual(resolveEditableLocation(hq, [{ location_id: "A", qty: 0 }], null), { ok: false, error: "no_stock" });
  assert.deepEqual(resolveEditableLocation(hq, [{ location_id: "A", qty: 1 }, { location_id: "B", qty: 1 }], "B"), { ok: true, locationId: "B" });
  assert.deepEqual(resolveEditableLocation(staffA, [{ location_id: "B", qty: 1 }], "B"), { ok: false, error: "forbidden" });
});

test("尺寸取整后为 0 或超上限：受控拒绝（不交给 DB check）", () => {
  assert.equal(validateMeasurementInput({ height_cm: 0.001 }).ok, false);
  assert.equal(validateMeasurementInput({ width_cm: 0.004 }).ok, false);
  assert.equal(validateMeasurementInput({ depth_cm: 9999.996 }).ok, false);
  const ok = validateMeasurementInput({ height_cm: 0.005 });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.height_cm, 0.01);
});
