import { test } from "node:test";
import assert from "node:assert/strict";
import { retouchRetryDelay } from "./retouch-retry.ts";
for (const error of [new TypeError("fetch failed"), {status:429}, {status:503}, new Error("图像生成服务未返回图片（stop），原图保留"), new Error("修图检查未通过（fields=product_present; confidence=0.80），原图保留，请重修")]) {
  test("classified temporary preview failure has bounded delay", () => {
    assert.equal(typeof retouchRetryDelay(error, 1), "number");
    assert.equal(retouchRetryDelay(error, 3), null);
  });
}
for (const error of [{code:"ai_consent_revoked"}, {status:401}, {status:403}, {status:400}, new Error("Original image must use trusted storage"), new Error("图像生成服务未返回图片（content_filter），原图保留"), new Error("permanent: blocked"), new Error("unknown")]) {
  test("permanent or unclassified failure stops", () => assert.equal(retouchRetryDelay(error,1), null));
}