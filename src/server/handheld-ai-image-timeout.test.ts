import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": "export const supabaseAdmin = {};",
  "@/server/product-recognition.server": "export const recognizeProductFromImages = () => {};",
  "./listing-image-safety.server":
    "export const measurementProtectionRequired = async () => false; export const loadOriginalImage = () => {}; export const squareOriginalImage = () => {};",
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
const { aiPrepareListingImage } = await import(
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
      controller.abort(new DOMException("Image request timed out", "TimeoutError"));
      init?.signal?.throwIfAborted();
      throw new Error("Expected abort");
    };
    await assert.rejects(aiPrepareListingImage({ image_url: "https://example.test/image" }), {
      name: "TimeoutError",
    });
    assert.deepEqual(deadlines, [60_000]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (originalKey === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = originalKey;
  }
});
