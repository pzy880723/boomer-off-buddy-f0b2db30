import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": "export const supabaseAdmin = {};",
  "@/server/product-recognition.server": "export const recognizeProductFromImages = () => {};",
  "./listing-image-safety.server":
    "export const measurementProtectionRequired = async () => false; export const loadOriginalImage = async (image) => { if (!image.startsWith('data:image/')) throw new Error('Original image must use trusted storage'); return Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'); }; export const squareOriginalImage = () => {}; export const withImageStage = (stage, run) => run().catch((e) => { e.stage = stage; throw e; });",
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

test("image generation uses a 60s abort deadline and propagates timeouts for durable retry", async () => {
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
      assert.equal(init?.signal, controller.signal);
      assert.ok(String(init?.body).includes(`data:image/png;base64,${PNG}`), "real PNG reached generation");
      controller.abort(new DOMException("Image request timed out", "TimeoutError"));
      init?.signal?.throwIfAborted();
      throw new Error("Expected abort");
    };
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }), {
      name: "TimeoutError",
      stage: "image_generation",
    });
    assert.deepEqual(deadlines, [60_000]);
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
    await assert.rejects(aiPrepareListingImage({ image_base64: PNG }), (e: any) => {
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
