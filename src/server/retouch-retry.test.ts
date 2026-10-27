import { test } from "node:test";
import assert from "node:assert/strict";
import { retouchRetryDelay } from "./retouch-retry.ts";
for (const error of [new TypeError("fetch failed"), {status:429}, {status:503}, new Error("图像生成服务未返回图片（stop），原图保留"), new Error("修图检查未通过（fields=product_present; confidence=0.80），原图保留，请重修")]) {
  test("classified temporary preview failure has bounded delay", () => {
    assert.equal(retouchRetryDelay(error, 1), (error as {status?:number}).status === 429 ? 900_000 : 30_000);
    assert.equal(retouchRetryDelay(error, 2), (error as {status?:number}).status === 429 ? 900_000 : 60_000);
    assert.equal(retouchRetryDelay(error, 3), null);
  });
}
for (const error of [{code:"ai_consent_revoked"}, {status:401}, {status:403}, {status:400}, new Error("Original image must use trusted storage"), new Error("图像生成服务未返回图片（content_filter），原图保留"), new Error("permanent: blocked"), new Error("unknown")]) {
  test("permanent or unclassified failure stops", () => assert.equal(retouchRetryDelay(error,1), null));
}
for (const message of ["provider refusal", "consent revoked", "invalid source", "unknown"]) {
  test(`wrapped 503 does not override permanent/unknown ${message}`, () => {
    const error = Object.assign(new Error(message), { stage: "image_generation", status: 503 });
    assert.equal(retouchRetryDelay(error, 1), message === "unknown" ? 30_000 : null);
  });
}
test("actual stage wrapper preserves temporary classification", async () => {
  const { withImageStage } = await import("./listing-image-safety.server.ts");
  for (const [stage, message, delay] of [
    ["image_generation", "图像生成服务未返回图片（stop），原图保留", 30_000],
    ["image_validation", "修图检查未通过（fields=product_present），原图保留", 30_000],
    ["measurement_detection", "Image classification HTTP 503", 30_000],
    ["image_generation", "AI gateway 429", 900_000],
  ] as const) {
    let caught: unknown;
    try { await withImageStage(stage, async () => { throw new Error(message); }); } catch (e) { caught = e; }
    assert.equal(retouchRetryDelay(caught, 1), delay);
  }
});
test("unknown transport name is not a network failure", () => {
  assert.equal(retouchRetryDelay(new TypeError("unknown"), 1), null);
  assert.equal(retouchRetryDelay(Object.assign(new Error("unknown"), { name: "TimeoutError" }), 1), null);
});