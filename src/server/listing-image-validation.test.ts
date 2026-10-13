import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { validatePreparedListingImage, retryInstructionFromError, assertListingImagePixels } from "./listing-image-safety.server.ts";
import { allowHandheldGuard, allowWebGuard } from "./ai-guard-fixtures.ts";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });
const valid = { product_present: true, product_scale: true, hands_removed: true, product_preserved: true, gray_background: true,
  measurement_preserved: true, detail_preserved: true, external_labels_removed: true, outer_bag_removed: true, confidence: 1 };
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
for (const field of ["product_present", "product_scale", "hands_removed", "product_preserved", "gray_background", "measurement_preserved", "detail_preserved", "external_labels_removed", "outer_bag_removed"]) {
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
test("leftover outer clear bag fails strictly; real transparent-bag products are protected in the prompt", async () => {
  globalThis.fetch = async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content[0].text;
    assert.match(text, /outer_bag_removed/); assert.match(text, /原图没有外层透明袋则填 true/);
    assert.match(text, /商品本身为透明袋\/透明材质时不算外袋/); assert.match(text, /外层透明包装袋属于允许操作/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, outer_bag_removed: false, confidence: 0.98 }) } }] });
  };
  await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard),
    /fields=outer_bag_removed; confidence=0.98/);
});
test("missing outer_bag_removed is a failure", async () => {
  const { outer_bag_removed: _d, ...rest } = valid;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(rest) } }] });
  await assert.rejects(validatePreparedListingImage("source", "output", "test", profile, allowHandheldGuard), /fields=outer_bag_removed/);
});
test("retry instruction uses only whitelisted fixed hints, deduped, unknown/free text ignored", () => {
  const hint = retryInstructionFromError("修图检查未通过（fields=outer_bag_removed,external_labels_removed,outer_bag_removed,evil_field; confidence=0.97） https://x.test/?token=1 13800000000");
  assert.ok(hint);
  assert.match(hint!, /外层透明袋/); assert.match(hint!, /外贴价签/);
  assert.equal(hint!.match(/外层透明袋/g)!.length, 1);
  assert.doesNotMatch(hint!, /evil|https|token|138|confidence/);
  assert.match(retryInstructionFromError("fields=product_preserved; confidence=0.99")!, /不得改动商品本体/);
  for (const e of [null, undefined, "[image_generation] TimeoutError", "fields=evil; confidence=1", "fields=none; confidence=0.5", 42])
    assert.equal(retryInstructionFromError(e), undefined);
});

const canvas = async (w: number, h: number, subject?: { w: number; h: number; color?: string }) => {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: "#ececec" } });
  if (subject) img = img.composite([{ input: await sharp({ create: { width: subject.w, height: subject.h, channels: 3,
    background: subject.color ?? "#3a5fb0" } }).png().toBuffer(), left: Math.floor((w - subject.w) / 2), top: Math.floor((h - subject.h) / 2) }]);
  return (await img.png().toBuffer()).toString("base64");
};
test("pixel gate: pure gray canvas is rejected as product_present", async () => {
  await assert.rejects(assertListingImagePixels(await canvas(1024, 1024)), (e: any) => {
    assert.equal(e.stage, "image_validation"); assert.match(e.message, /fields=product_present; confidence=invalid/); return true;
  });
});
test("pixel gate: tiny centered subject is rejected as product_scale", async () => {
  await assert.rejects(assertListingImagePixels(await canvas(1024, 1024, { w: 300, h: 260 })), /fields=product_scale; confidence=invalid/);
});
test("pixel gate: normal product framing (~75% long edge) passes", async () => {
  await assertListingImagePixels(await canvas(1024, 1024, { w: 770, h: 560 }));
  await assertListingImagePixels(await canvas(1024, 1024, { w: 420, h: 820, color: "#d8c9a0" }));
});
test("pixel gate: non-square, too small or undecodable outputs are rejected", async () => {
  await assert.rejects(assertListingImagePixels(await canvas(1024, 768, { w: 700, h: 600 })), /fields=canvas_square/);
  await assert.rejects(assertListingImagePixels(await canvas(512, 512, { w: 380, h: 380 })), /fields=canvas_square/);
  await assert.rejects(assertListingImagePixels("ZWRpdGVk"), /fields=product_present/);
});
test("pixel gate: dark/non-gray background is rejected", async () => {
  const dark = (await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#202020" } }).png().toBuffer()).toString("base64");
  await assert.rejects(assertListingImagePixels(dark), /fields=gray_background/);
});
test("validation prompt requires product_present/product_scale and keeps the bagged product", async () => {
  globalThis.fetch = async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[0].content[0].text;
    for (const w of ["product_present", "product_scale", "纯灰图", "袋中商品", "商品本体必须完整可见", "70%-85%"]) assert.match(text, new RegExp(w));
    return Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] });
  };
  await validatePreparedListingImage("source", "output", "test", { measurementTool: false, closeUp: false }, allowHandheldGuard);
});
test("retry hints for product_present/product_scale are fixed and never ask to delete anything", () => {
  const hint = retryInstructionFromError("[image_validation] fields=product_present,product_scale; confidence=invalid")!;
  assert.match(hint, /空背景/); assert.match(hint, /70%-85%/);
  assert.doesNotMatch(hint, /删除|去除|删掉/);
  assert.match(retryInstructionFromError("fields=canvas_square; confidence=invalid")!, /1024x1024/);
});
