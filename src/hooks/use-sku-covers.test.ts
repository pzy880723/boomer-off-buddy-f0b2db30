import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  react: "export const useMemo = fn => fn();",
  "@tanstack/react-query": "export const useQuery = options => { globalThis.__coverQuery = options; return {data:undefined,isLoading:false}; };",
  "@tanstack/react-start": "export const useServerFn = fn => fn;",
  "@/lib/sku-covers.functions": "export const signSkuCovers = async input => input;",
};
const bundle = await build({
  entryPoints: ["src/hooks/use-sku-covers.ts"], bundle: true, write: false,
  platform: "node", format: "esm",
  plugins: [{ name: "hook-dependencies", setup(b: any) {
    b.onResolve({ filter: /.*/ }, (a: any) => stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
});
const { useSkuCovers } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const state = globalThis as typeof globalThis & { __coverQuery: any };

test("refreshing product data changes the cover cache even when SKU IDs stay the same", () => {
  useSkuCovers(["kitty", "korg"], 100);
  const before = state.__coverQuery.queryKey;
  useSkuCovers(["kitty", "korg"], 200);
  assert.notDeepEqual(state.__coverQuery.queryKey, before);
});

test("SKU order/dedup stays stable and revision is not sent to the signing API", async () => {
  useSkuCovers(["korg", "kitty", "kitty"], 100);
  const before = state.__coverQuery.queryKey;
  useSkuCovers(["kitty", "korg"], 100);
  assert.deepEqual(state.__coverQuery.queryKey, before);
  assert.deepEqual(await state.__coverQuery.queryFn(), { data: { sku_ids: ["kitty", "korg"] } });
  useSkuCovers([], 100);
  assert.equal(state.__coverQuery.enabled, false);
});

test("all three product lists connect their data revision to the cover cache", () => {
  for (const [file, query] of [
    ["src/routes/inventory.skus.index.tsx", "q"],
    ["src/routes/m.skus.index.tsx", "q"],
    ["src/routes/shop-mgmt.products.tsx", "rowsQ"],
  ]) {
    assert.ok(readFileSync(file, "utf8").includes(`useSkuCovers(allSkuIds, ${query}.dataUpdatedAt)`), file);
  }
});
