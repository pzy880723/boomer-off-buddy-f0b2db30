import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { validatePreparedListingImage } from "./listing-image-safety.server.ts";
import { allowHandheldGuard, allowWebGuard } from "./ai-guard-fixtures.ts";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });
const valid = { hands_removed: true, product_preserved: true, gray_background: true,
  measurement_preserved: true, detail_preserved: true, external_labels_removed: true, confidence: 1 };
const profile = { measurementTool: true, closeUp: true };

test("source and output are compared for hand removal, ruler evidence and detail angle", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "google/gemini-2.5-flash");
    assert.deepEqual(body.messages[0].content.filter((c: any) => c.type === "image_url").map((c: any) => c.image_url.url),
      ["data:image/png;base64,c291cmNl", "data:image/png;base64,b3V0cHV0"]);
    const text = body.messages[0].content[0].text;
    for (const word of ["手指", "手掌", "手臂", "玩偶", "刻度", "数字", "角度", "浅灰"]) assert.match(text, new RegExp(word));
    return Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] });
  };
  await validatePreparedListingImage("data:image/png;base64,c291cmNl", "data:image/png;base64,b3V0cHV0", "test", profile, allowHandheldGuard);
});
for (const field of ["hands_removed", "product_preserved", "gray_background", "measurement_preserved", "detail_preserved", "external_labels_removed"]) {
  test(`${field}=false cannot be reported as a completed retouch`, async () => {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, [field]: false }) } }] });
    await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard), (e: any) => e.stage === "image_validation");
  });
}
for (const confidence of [0.94, 1.1, "1", null]) {
  test(`invalid/uncertain validation confidence ${confidence} retains original for retry`, async () => {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, confidence }) } }] });
    await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard));
  });
}
test("truncated or unavailable validation fails without leaking upstream text", async () => {
  for (const response of [new Response("https://private.test?token=secret", { status: 503 }),
    Response.json({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(valid) } }] }),
    Response.json({ choices: [{ message: { content: "{}" } }] })]) {
    globalThis.fetch = async () => response;
    await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard), (e: any) => {
      assert.equal(e.stage, "image_validation"); assert.doesNotMatch(e.message, /private|secret/); return true;
    });
  }
});
test("validation timeout stays a retryable staged TimeoutError", async () => {
  const controller = new AbortController();
  AbortSignal.timeout = ms => { assert.equal(ms, 20_000); return controller.signal; };
  globalThis.fetch = async (_url, init) => {
    controller.abort(new DOMException("Validation deadline", "TimeoutError"));
    init?.signal?.throwIfAborted();
    throw Error("Expected abort");
  };
  await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard),
    { name: "TimeoutError", stage: "image_validation" });
});
test("conservative ruler profile does not require adding a ruler to photos without one", async () => {
  globalThis.fetch = async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content[0].text;
    assert.match(text, /若原图有外部测量工具/);
    assert.match(text, /原图没有外部测量工具则填 true，不能要求成品添加尺子/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] });
  };
  await validatePreparedListingImage("source", "output", "test", { measurementTool: true, closeUp: true }, allowHandheldGuard);
});
test("leftover external price sticker fails even when gray_background=true, with safe field-level error", async () => {
  globalThis.fetch = async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content[0].text;
    assert.match(text, /external_labels_removed/); assert.match(text, /透明包装/); assert.match(text, /不算违规/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, external_labels_removed: false,
      confidence: 0.97, note: "SECRET https://x.test/a?token=1 13800000000" }) } }] });
  };
  await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard), (e: any) => {
    assert.equal(e.stage, "image_validation");
    assert.equal(e.message, "修图检查未通过（fields=external_labels_removed; confidence=0.97），原图保留，请重修");
    assert.doesNotMatch(e.message, /SECRET|https|token|138/);
    return true;
  });
});
test("missing external_labels_removed field is a failure, not a pass", async () => {
  const { external_labels_removed: _drop, ...noLabel } = valid;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(noLabel) } }] });
  await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard),
    /fields=external_labels_removed; confidence=1.00/);
});
test("low confidence failure names confidence without passing", async () => {
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, confidence: 0.94 }) } }] });
  await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard),
    /fields=none; confidence=0.94/);
});
