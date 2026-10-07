import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import sharp from "sharp";
import { requiresOriginalMeasurementPixels, squareOriginalImage, loadOriginalImage, measurementProtectionRequired } from "./listing-image-safety.server.ts";

test("ambiguous or missing ruler detection rejects instead of reporting prepared pixels", () => {
  for (const value of [null, {}, { confidence: 1 }, { measurement_tool: "false", confidence: 1 }, { measurement_tool: false, confidence: 0.9 }]) {
    assert.throws(() => requiresOriginalMeasurementPixels(value), /measurement/i);
  }
  assert.equal(requiresOriginalMeasurementPixels({ measurement_tool: false, confidence: 0.99 }), false);
});
test("a detected measurement tool remains protected even at low confidence", () => {
  for (const confidence of [0, 0.5, 1]) {
    assert.equal(requiresOriginalMeasurementPixels({ measurement_tool: true, confidence }), true);
  }
});
for (const confidence of [NaN, Infinity, -Infinity, -0.01, 1.01, 99, "0.99", null, undefined]) {
  test(`invalid ruler confidence ${String(confidence)} requires retry`, () => {
    assert.throws(() => requiresOriginalMeasurementPixels({ measurement_tool: false, confidence }), /measurement/i);
  });
}
test("ruler confidence must meet the threshold within the finite unit interval", () => {
  for (const confidence of [0, 0.949]) {
    assert.throws(() => requiresOriginalMeasurementPixels({ measurement_tool: false, confidence }), /measurement/i);
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

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalKey = process.env.LOVABLE_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  if (originalKey === undefined) delete process.env.LOVABLE_API_KEY;
  else process.env.LOVABLE_API_KEY = originalKey;
});

for (const status of [401, 429, 500]) {
  test(`measurement HTTP ${status} rejects for retry without leaking response text`, async () => {
    globalThis.fetch = async () => new Response("private upstream response", { status });
    await assert.rejects(measurementProtectionRequired("https://fixture.test/image", "fixture"), error => {
      assert.match(String(error), new RegExp(`measurement.*${status}`, "i"));
      assert.doesNotMatch(String(error), /private upstream response/);
      return true;
    });
  });
}
test("background measurement uses a 60s deadline and propagates timeouts for retry", async () => {
  const controller = new AbortController();
  AbortSignal.timeout = ms => { assert.equal(ms, 60_000); return controller.signal; };
  globalThis.fetch = async (_url, init) => {
    controller.abort(new DOMException("measurement deadline", "TimeoutError"));
    init?.signal?.throwIfAborted();
    throw Error("expected abort");
  };
  await assert.rejects(measurementProtectionRequired("https://fixture.test/image", "fixture"), { name: "TimeoutError" });
});
test("measurement request reserves at least 512 tokens for reasoning and strict JSON output", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.max_tokens >= 512, `Detector token budget too small: ${body.max_tokens}`);
    assert.deepEqual(body.response_format, { type: "json_object" });
    return Response.json({ choices: [{ message: { content: '{"measurement_tool":false,"confidence":1}' } }] });
  };
  assert.equal(await measurementProtectionRequired("https://fixture.test/image", "fixture"), false);
});
for (const body of ["not json", JSON.stringify({ choices: [{ message: { content: "not json" } }] }), JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "Here is the" } }] }), "{}"]) {
  test(`malformed detector response rejects: ${body}`, async () => {
    globalThis.fetch = async () => new Response(body);
    await assert.rejects(measurementProtectionRequired("https://fixture.test/image", "fixture"));
  });
}

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": "export const supabaseAdmin={};",
  "@/server/product-recognition.server": "export const recognizeProductFromImages=()=>{};",
};
const bundle = await build({ entryPoints: ["src/server/handheld-ai.server.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["sharp"], plugins: [{ name: "non-image-boundaries", setup(b: any) {
    b.onResolve({ filter: /.*/ }, (a: any) => stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path], loader: "js" }));
  } }] });
const module = { exports: {} as any };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);

test("preparation cannot return a successful image when detection is unavailable", async () => {
  process.env.LOVABLE_API_KEY = "fixture";
  const source = await sharp({ create: { width: 8, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("unavailable", { status: 503 }); };
  await assert.rejects(module.exports.aiPrepareListingImage({ image_base64: `data:image/png;base64,${source.toString("base64")}` }));
  assert.equal(calls, 1, "No image-generation or source-download fallback may follow detection failure");
});

test("preparation still preserves real ruler pixels without calling the generative model", async () => {
  process.env.LOVABLE_API_KEY = "fixture";
  const pixels = Buffer.from(Array.from({ length: 8 * 4 * 3 }, (_, i) => i % 256));
  const source = await sharp(pixels, { raw: { width: 8, height: 4, channels: 3 } }).png().toBuffer();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).model, "google/gemini-2.5-flash");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ measurement_tool: true, confidence: 1 }) } }] });
  };
  const output = await module.exports.aiPrepareListingImage({ image_base64: `data:image/png;base64,${source.toString("base64")}` });
  assert.equal(calls, 1);
  assert.deepEqual(await sharp(Buffer.from(output.b64, "base64")).extract({ left: 0, top: 2, width: 8, height: 4 }).removeAlpha().raw().toBuffer(), pixels);
});

test("confident no-tool detection still reaches the image editing provider", async () => {
  process.env.LOVABLE_API_KEY = "fixture";
  const models: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    if (models.length === 1) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ measurement_tool: false, confidence: 0.99 }) } }] });
    }
    assert.deepEqual(body.modalities, ["image", "text"]);
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,ZWRpdGVk" } }] } }] });
  };
  assert.deepEqual(await module.exports.aiPrepareListingImage({ image_url: "https://fixture.test/image" }), { b64: "ZWRpdGVk", mime: "image/png" });
  assert.deepEqual(models, ["google/gemini-2.5-flash", "google/gemini-3.1-flash-image"]);
});

test("detector only protects external measuring tools, excluding product scales like tonearms and radio dials", async () => {
  let prompt = "";
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(String(init?.body)).messages[0].content[0].text;
    return Response.json({ choices: [{ message: { content: '{"measurement_tool":false,"confidence":0.99}' } }] });
  };
  assert.equal(await measurementProtectionRequired("https://fixture.test/image", "fixture"), false);
  for (const tool of ["尺子", "卷尺", "卡尺", "测量垫", "外部"]) assert.match(prompt, new RegExp(tool));
  for (const part of ["唱臂", "频率", "旋钮", "装饰网格", "型号", "年份"]) assert.match(prompt, new RegExp(part));
  assert.match(prompt, /不算测量工具/);
});
test("measurement failure keeps TimeoutError type and adds a safe stage marker", async () => {
  const controller = new AbortController();
  AbortSignal.timeout = () => controller.signal;
  globalThis.fetch = async (_url, init) => { controller.abort(new DOMException("deadline", "TimeoutError")); init?.signal?.throwIfAborted(); throw Error("x"); };
  await assert.rejects(measurementProtectionRequired("https://fixture.test/image?token=secret", "fixture"), (e: any) => {
    assert.equal(e.name, "TimeoutError"); assert.equal(e.stage, "measurement_detection");
    assert.doesNotMatch(String(e.message), /token=secret/); return true;
  });
});
test("image generation HTTP error is stage-marked and never echoes upstream text", async () => {
  process.env.LOVABLE_API_KEY = "fixture";
  let n = 0;
  globalThis.fetch = async () => (++n === 1
    ? Response.json({ choices: [{ message: { content: '{"measurement_tool":false,"confidence":1}' } }] })
    : new Response("https://x.test/sign?token=leak data:image/png;base64,AAAA", { status: 500 }));
  await assert.rejects(module.exports.aiPrepareListingImage({ image_url: "https://fixture.test/image" }), (e: any) => {
    assert.equal(e.stage, "image_generation"); assert.match(e.message, /500/); assert.doesNotMatch(e.message, /token|base64/); return true;
  });
});
test("listing prompt removes platform watermarks and price tags while keeping product marks", async () => {
  process.env.LOVABLE_API_KEY = "fixture";
  let text = "";
  let n = 0;
  globalThis.fetch = async (_url, init) => {
    if (++n === 1) return Response.json({ choices: [{ message: { content: '{"measurement_tool":false,"confidence":1}' } }] });
    text = JSON.parse(String(init?.body)).messages[0].content[0].text;
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,ZQ==" } }] } }] });
  };
  await module.exports.aiPrepareListingImage({ image_url: "https://fixture.test/image" });
  for (const word of ["闲鱼", "水印", "价签|价格牌", "商标", "真实瑕疵", "刻度"]) assert.match(text, new RegExp(word));
});
