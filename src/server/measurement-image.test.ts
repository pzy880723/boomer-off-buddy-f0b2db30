import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { validateMeasurementImage, deriveMeasurementPngs } from "./measurement-image.server";

/** 合成透明 PNG：中心放一个 w×h 不透明矩形 */
async function makeTransparentPng(w: number, h: number, canvas = 400): Promise<Buffer> {
  const rect = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: rect, left: 100, top: 100 }])
    .png()
    .toBuffer();
}

test("合法透明 PNG：通过并返回 bbox/px_per_cm", async () => {
  // 前景 100×200（高宽比 2.0），实测 20cm 高 10cm 宽（比 2.0）
  const png = await makeTransparentPng(100, 200);
  const res = await validateMeasurementImage(png, { height_cm: 20, width_cm: 10, diameter_cm: null });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.frontWidthPx, 100);
    assert.equal(res.value.frontHeightPx, 200);
    assert.equal(res.value.bbox.x, 100);
    assert.equal(res.value.bbox.y, 100);
    assert.equal(res.value.pxPerCm, 10);
  }
});

test("不透明图片拒绝（no_alpha）", async () => {
  const opaque = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const res = await validateMeasurementImage(opaque, { height_cm: 10, width_cm: 10, diameter_cm: null });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "no_alpha");
});

test("非 PNG 拒绝（not_png）", async () => {
  const jpeg = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer();
  const res = await validateMeasurementImage(jpeg, { height_cm: 10, width_cm: 10, diameter_cm: null });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "not_png");
});

test("高宽比与实测比偏差 >3% 拒绝（ratio_mismatch）", async () => {
  // 前景 100×200（比 2.0），实测 20×20（比 1.0）→ 拒绝
  const png = await makeTransparentPng(100, 200);
  const res = await validateMeasurementImage(png, { height_cm: 20, width_cm: 20, diameter_cm: null });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "ratio_mismatch");
});

test("高宽比在 3% 容差内通过", async () => {
  // 前景 100×200（比 2.0），实测 20×9.8（比 ≈2.0408，差 2%）→ 通过
  const png = await makeTransparentPng(100, 200);
  const res = await validateMeasurementImage(png, { height_cm: 20, width_cm: 9.8, diameter_cm: null });
  assert.equal(res.ok, true);
});

test("缺 width 时用 diameter 代替；都缺拒绝（missing_measurement）", async () => {
  const png = await makeTransparentPng(100, 200);
  const viaDiameter = await validateMeasurementImage(png, { height_cm: 20, width_cm: null, diameter_cm: 10 });
  assert.equal(viaDiameter.ok, true);
  const missing = await validateMeasurementImage(png, { height_cm: 20, width_cm: null, diameter_cm: null });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, "missing_measurement");
});

test("衍生 640/1280 透明 PNG：保留 alpha、不放大", async () => {
  const png = await makeTransparentPng(100, 200);
  const res = await validateMeasurementImage(png, { height_cm: 20, width_cm: 10, diameter_cm: null });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const { png640, png1280 } = await deriveMeasurementPngs(res.value.trimmedPng);
  const m640 = await sharp(png640).metadata();
  const m1280 = await sharp(png1280).metadata();
  assert.equal(m640.format, "png");
  assert.equal(m640.hasAlpha, true);
  // 原图 trim 后 100px 宽，不放大
  assert.equal(m640.width, 100);
  assert.equal(m1280.width, 100);
});
