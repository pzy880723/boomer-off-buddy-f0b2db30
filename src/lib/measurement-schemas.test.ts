import test from "node:test";
import assert from "node:assert/strict";
import { reportMeasurementDiagramInput } from "./measurement-schemas";

const SKU = "11111111-1111-4111-8111-111111111111";

test("旧素材上报只接受 failed：ready 及携带路径/几何一律拒绝", () => {
  assert.equal(reportMeasurementDiagramInput.safeParse({ sku_id: SKU, revision: 1, status: "ready" }).success, false);
  assert.equal(
    reportMeasurementDiagramInput.safeParse({
      sku_id: SKU, revision: 1, status: "ready", verified: true,
      cutout_preview_path: `sku-listing/measurements/${SKU}/1-aaaaaaaaaaaaaaaa-640.png`,
    }).success,
    false,
  );
  assert.equal(
    reportMeasurementDiagramInput.safeParse({ sku_id: SKU, revision: 1, status: "failed", cutout_preview_path: "x.png" }).success,
    false,
  );
  assert.equal(reportMeasurementDiagramInput.safeParse({ sku_id: SKU, revision: 1, status: "failed", error: "seg failed" }).success, true);
});
