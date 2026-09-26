import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { requiresOriginalMeasurementPixels, squareOriginalImage, loadOriginalImage } from "./listing-image-safety.server";

test("uncertain ruler detection preserves the original instead of generative editing", () => {
  for (const value of [null, {}, { measurement_tool: true, confidence: 1 }, { measurement_tool: false, confidence: 0.9 }]) {
    assert.equal(requiresOriginalMeasurementPixels(value), true);
  }
  assert.equal(requiresOriginalMeasurementPixels({ measurement_tool: false, confidence: 0.99 }), false);
});
for (const confidence of [NaN, Infinity, -Infinity, -0.01, 1.01, 99, "0.99", null, undefined]) {
  test(`invalid ruler confidence ${String(confidence)} preserves original pixels`, () => {
    assert.equal(requiresOriginalMeasurementPixels({ measurement_tool: false, confidence }), true);
  });
}
test("ruler confidence must meet the threshold within the finite unit interval", () => {
  for (const confidence of [0, 0.949]) {
    assert.equal(requiresOriginalMeasurementPixels({ measurement_tool: false, confidence }), true);
  }
  for (const confidence of [0.95, 1]) {
    assert.equal(requiresOriginalMeasurementPixels({ measurement_tool: false, confidence }), false);
  }
});
test("square padding keeps every original pixel, including ruler markings", async () => {
  const pixels = Buffer.from(Array.from({ length: 8 * 4 * 3 }, (_, i) => i % 256));
  const source = await sharp(pixels, { raw: { width: 8, height: 4, channels: 3 } }).png().toBuffer();
  const output = await squareOriginalImage(source);
  const image = sharp(Buffer.from(output.b64, "base64"));
  assert.equal((await image.metadata()).width, 8);
  assert.equal((await image.metadata()).height, 8);
  assert.deepEqual(await image.extract({ left: 0, top: 2, width: 8, height: 4 }).removeAlpha().raw().toBuffer(), pixels);
});
test("original image loader does not fetch arbitrary servers", async () => {
  await assert.rejects(loadOriginalImage("http://127.0.0.1/private"), /trusted storage/);
});
