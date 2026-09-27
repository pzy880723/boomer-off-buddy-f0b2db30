import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const container = "({children}) => children";
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": "export const supabaseAdmin = {storage:{from:bucket=>globalThis.__imageStorage(bucket)}};",
  "@tanstack/react-router": `export const Link = ${container};`,
  "@/components/ui/dialog": `export const Dialog = ${container}; export const DialogContent = ${container};`,
  "@/components/ui/card": `export const Card = ${container};`,
  "@/components/ui/badge": `export const Badge = ${container};`,
  "lucide-react": "export const Tags=()=>null, Boxes=Tags, Printer=Tags, ChevronRight=Tags;",
};
const bundle = await build({
  stdin: {
    contents: `export { SkuImageGallery } from './src/components/inventory/sku-image-gallery';
      export { SingleSkuRow, SingleSkuCard } from './src/components/inventory/product-card';
      export { signSkuImagePaths } from './src/lib/sku-image-resolver.server';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "display-dependencies", setup(b: any) {
    b.onResolve({ filter: /.*/ }, (a: any) => {
      if (stubs[a.path]) return { path: a.path, namespace: "stub" };
      if (/^react(?:\/|$)/.test(a.path)) return { path: pathToFileURL(require.resolve(a.path)).href, external: true };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
});
const { SkuImageGallery, SingleSkuRow, SingleSkuCard, signSkuImagePaths } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const urls = ["front", "back"].map(name => `https://storage.test/storage/v1/object/sign/sku-listing/${name}.png?token=opaque-${name}`);
function sources(component: any, props: any) {
  const { document } = parseHTML(renderToStaticMarkup(createElement(component, props)));
  return Array.from(document.querySelectorAll("img")).map(img => img.getAttribute("src"));
}

test("actual desktop list and grid img src preserve the private object signature", () => {
  const row = { id: "korg", kind: "single", name: "KORG", category: "digital", price_tier: 299 };
  for (const component of [SingleSkuRow, SingleSkuCard])
    assert.deepEqual(sources(component, { row, coverOverride: urls[0] }), [urls[0]]);
});

test("actual detail main image and both thumbnails preserve server signatures", () => {
  assert.deepEqual(sources(SkuImageGallery, { images: urls, alt: "KORG" }), [urls[0], ...urls]);
});

test("detail gallery fallback also preserves its private signature", () => {
  assert.deepEqual(sources(SkuImageGallery, { images: [], fallbackUrl: urls[0], alt: "KORG" }), [urls[0]]);
});

test("server resolver batches private paths and returns the exact SDK URL in original order", async () => {
  const calls: unknown[] = [];
  const state = globalThis as typeof globalThis & { __imageStorage?: unknown };
  state.__imageStorage = (bucket: string) => ({
    createSignedUrls: async (paths: string[], ttl: number) => {
      calls.push({ bucket, paths, ttl });
      return { data: paths.map((_, i) => ({ signedUrl: urls[i] })), error: null };
    },
  });
  try {
    assert.deepEqual(await signSkuImagePaths([
      "sku-listing/front.png", "https://cdn.test/public.png", "sku-listing/back.png", "unknown/a.png",
    ]), [urls[0], "https://cdn.test/public.png", urls[1], null]);
    assert.deepEqual(calls, [{ bucket: "sku-listing", paths: ["front.png", "back.png"], ttl: 86400 }]);
  } finally {
    delete state.__imageStorage;
  }
});
