import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundle = await build({ entryPoints: ["src/lib/youzan-image-media.ts"], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["sharp"] });
const module = { exports: {} as any };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
const { buildHqImageParams, imageRefreshSources } = module.exports;
test("HQ image request includes every image and no stock/channel/barcode fields", () => {
  assert.deepEqual(buildHqImageParams(12, ["https://cdn/a", "https://cdn/b"]), {
    spu_id: 12, photo_url: '[{"url":"https://cdn/a"},{"url":"https://cdn/b"}]',
  });
});
test("refresh uses all ordered image_paths, not stale image_url; pending raw is retryable", () => {
  const sku = { image_paths: ["sku-listing/a.png", "sku-listing/b.png"], image_url: "https://old/raw.jpg" };
  assert.deepEqual(imageRefreshSources(sku, "https://erp.boomeroff.com"), [
    "https://erp.boomeroff.com/api/public/media/sku/sku-listing/a.png",
    "https://erp.boomeroff.com/api/public/media/sku/sku-listing/b.png",
  ]);
  assert.throws(() => imageRefreshSources({ image_paths: ["sku-listing/a", "sku-raw/b"] }, "https://erp.boomeroff.com"), /pending/);
  assert.equal(imageRefreshSources({ image_paths: Array.from({ length: 6 }, (_, i) => `sku-listing/${i}`) }, "https://erp.boomeroff.com").length, 6);
});
