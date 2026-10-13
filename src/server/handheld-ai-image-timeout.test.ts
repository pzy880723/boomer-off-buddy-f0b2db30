import { allowHandheldGuard } from "./ai-guard-fixtures.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": "export const supabaseAdmin = {};",
  "@/server/product-recognition.server": "export const recognizeProductFromImages = () => {};",
  sharp: "export default () => ({ metadata: async () => ({ orientation: 1 }) });",
  "./listing-image-safety.server":
    "export const classifyListingImage = async () => ({ measurementTool: globalThis.__ruler === true, closeUp: false }); export const validatePreparedListingImage = async () => {}; export const assertListingImagePixels = async () => {}; export const loadOriginalImage = async (image) => { if (!image.startsWith('data:image/')) throw new Error('Original image must use trusted storage'); return Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'); }; export const withImageStage = (stage, run) => run().catch((e) => { e.stage = stage; throw e; }); export const analysisCopy = async (u) => u; export const stageSignal = (ms, b) => { const s = AbortSignal.timeout(ms); return b ? AbortSignal.any([s, b]) : s; }; export class PermanentImageError extends Error { constructor(m) { super('permanent: ' + m); } } export const LISTING_IMAGE_BUDGET_MS = 120000; export const GENERATION_TIMEOUT_MS = 40000; export const FALLBACK_GENERATION_TIMEOUT_MS = 60000; globalThis.__guardChecks = globalThis.__guardChecks || [];",
};
const bundle = await build({
  entryPoints: ["src/server/handheld-ai.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "stubs",
      setup(b: any) {
        b.onResolve({ filter: /.*/ }, (a: any) =>
          stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({
          contents: stubs[a.path],
          loader: "js",
        }));
      },
    },
  ],
});
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const { aiPrepareListingImage, missingImageError } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("image generation uses a 40s primary deadline inside the 120s photo budget and propagates timeouts for durable retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalKey = process.env.LOVABLE_API_KEY;
  const deadlines: number[] = [];
  const controller = new AbortController();
  try {
    process.env.LOVABLE_API_KEY = "test-only";
    AbortSignal.timeout = (ms: number) => {
      deadlines.push(ms);
      return controller.signal;
    };
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.image_config, { image_size: "1K", aspect_ratio: "1:1" });
      assert.ok(String(init?.body).includes(`data:image/png;base64,${PNG}`), "real PNG reached generation");
      controller.abort(new DOMException("Image request timed out", "TimeoutError"));
      init?.signal?.throwIfAborted();
      throw new Error("Expected abort");
    };
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard), {
      name: "TimeoutError",
      stage: "image_generation",
    });
    assert.deepEqual(deadlines, [120_000, 40_000]); // budget expired: no fallback
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (originalKey === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = originalKey;
  }
});

async function withFetch(response: unknown, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  process.env.LOVABLE_API_KEY = "test-only";
  globalThis.fetch = async () => new Response(JSON.stringify(response), { status: 200 });
  try { await run(); } finally { globalThis.fetch = originalFetch; }
}

test("content_filter 200 without image fails with safe error and no original returned", async () => {
  await withFetch({ choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "SECRET https://x.test/a?token=1" } }] }, async () => {
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard), (e: any) => {
      assert.equal(e.message, "图像生成服务未返回图片（content_filter），原图保留");
      assert.equal(e.stage, "image_generation");
      assert.ok(!e.message.includes("SECRET") && !e.message.includes("token"));
      return true;
    });
  });
});

test("other missing-image finish reasons are diagnosed without leaking", () => {
  assert.equal(missingImageError("stop"), "图像生成服务未返回图片（stop），原图保留");
  assert.equal(missingImageError(undefined), "图像生成服务未返回图片（unknown），原图保留");
  assert.equal(missingImageError("evil https://x?token=1"), "图像生成服务未返回图片（unknown），原图保留");
});

test("ruler photos now reach the editing provider with no rotation and intact measurement rules", async () => {
  (globalThis as any).__ruler = true;
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    called = true;
    const prompt = JSON.parse(String(init?.body)).messages[0].content[0].text;
    assert.match(prompt, /禁止校正角度/);
    assert.match(prompt, /刻度和数字必须完整保留/);
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,ZWRpdGVk" } }] } }] });
  };
  try {
    const out = await aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard);
    assert.deepEqual(out, { b64: "ZWRpdGVk", mime: "image/png" });
    assert.equal(called, true);
  } finally { globalThis.fetch = originalFetch; (globalThis as any).__ruler = false; }
});

test("non-protected branch keeps original return shape without preserved_original", async () => {
  await withFetch({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,QUJD" } }] } }] }, async () => {
    const out = await aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard);
    assert.deepEqual(out, { mime: "image/png", b64: "QUJD" });
    assert.equal("preserved_original" in out, false);
  });
});

test("total 120s budget expiring after validation never returns success", async () => {
  const budget = new AbortController();
  const originalFetch = globalThis.fetch;
  process.env.LOVABLE_API_KEY = "test-only";
  globalThis.fetch = async () => {
    budget.abort(new DOMException("Photo budget", "TimeoutError"));
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,QUJD" } }] } }] });
  };
  try {
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard, budget.signal), { name: "TimeoutError" });
  } finally { globalThis.fetch = originalFetch; }
});

const IMG = (b64: string) => Response.json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }] });
const countingGuard = () => { const stages: string[] = []; return { stages, guard: { ...allowHandheldGuard,
  check: async (stage: string) => { stages.push(stage); return (allowHandheldGuard as any).check?.(stage); } } }; };

async function withFetchSeq(handlers: Array<(body: any, init: any) => Promise<Response> | Response>, run: (bodies: any[]) => Promise<void>) {
  const originalFetch = globalThis.fetch; const bodies: any[] = [];
  process.env.LOVABLE_API_KEY = "test-only";
  globalThis.fetch = async (_u, init) => { const b = JSON.parse(String(init?.body)); bodies.push(b);
    const h = handlers[bodies.length - 1]; if (!h) throw new Error("unexpected extra call"); return h(b, init); };
  try { await run(bodies); } finally { globalThis.fetch = originalFetch; }
}

for (const [label, primary] of [
  ["TimeoutError", () => { throw new DOMException("t", "TimeoutError"); }],
  ["network TypeError", () => { throw new TypeError("fetch failed"); }],
  ["HTTP 503", () => new Response("x", { status: 503 })],
] as const) {
  test(`primary ${label} => one fallback to 2.5-flash-image with same input, 60s deadline, consent rechecked`, async () => {
    const { guard, stages } = countingGuard();
    await withFetchSeq([primary as any, () => IMG("RkI=")], async (bodies) => {
      const out = await aiPrepareListingImage({ image_base64: PNG }, guard as any);
      assert.deepEqual(out, { mime: "image/png", b64: "RkI=" });
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].model, "google/gemini-3.1-flash-image");
      assert.deepEqual(bodies[0].image_config, { image_size: "1K", aspect_ratio: "1:1" });
      assert.equal(bodies[1].model, "google/gemini-2.5-flash-image");
      assert.deepEqual(bodies[1].image_config, { aspect_ratio: "1:1" });
      assert.deepEqual(bodies[1].messages, bodies[0].messages);
      assert.equal(stages.filter((s) => s === "image_generation").length, 2);
    });
  });
}

for (const [label, primary, expected] of [
  ["403", () => new Response("x", { status: 403 }), /permanent: AI gateway 403/],
  ["401", () => new Response("x", { status: 401 }), /permanent: AI gateway 401/],
  ["429", () => new Response("x", { status: 429 }), /AI gateway 429/],
  ["content_filter", () => Response.json({ choices: [{ finish_reason: "content_filter", message: {} }] }), /content_filter/],
] as const) {
  test(`primary ${label} does not fall back`, async () => {
    await withFetchSeq([primary as any], async (bodies) => {
      await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard), expected as RegExp);
      assert.equal(bodies.length, 1);
    });
  });
}

test("expired total budget does not fall back", async () => {
  const budget = new AbortController();
  await withFetchSeq([() => { budget.abort(new DOMException("b", "TimeoutError")); throw new DOMException("b", "TimeoutError"); }], async (bodies) => {
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, allowHandheldGuard, budget.signal), { name: "TimeoutError" });
    assert.equal(bodies.length, 1);
  });
});

test("consent revoked before fallback blocks the fallback call", async () => {
  let n = 0;
  const guard = { ...allowHandheldGuard, check: async (stage: string) => {
    if (stage === "image_generation" && ++n === 2) { const e: any = new Error("denied"); e.code = "ai_consent_revoked"; throw e; } } };
  await withFetchSeq([() => { throw new DOMException("t", "TimeoutError"); }], async (bodies) => {
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, guard as any));
    assert.equal(bodies.length, 1);
  });
});
