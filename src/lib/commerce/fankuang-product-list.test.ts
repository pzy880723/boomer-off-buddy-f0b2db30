import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createClient } from "@supabase/supabase-js";
import type { Plugin } from "esbuild";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundled = await build({ entryPoints: ["src/components/inventory/product-card.tsx"], bundle: true,
  write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime"],
  plugins: [{ name: "link-boundary", setup(b: Parameters<Plugin["setup"]>[0]) {
    b.onResolve({ filter: /^@tanstack\/react-router$/ }, () => ({ path: "link", namespace: "test" }));
    b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'import React from "react";export const Link = ({children}) => React.createElement("a",null,children);' }));
  } }] });
const module = { exports: {} as any };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(require, module, module.exports);
const row = { id: "cup", name: "杯", category: "toy", price_tier: 9.9, kind: "single", is_custom_price: true,
  inventory_policy: "tracked", fankuang_override: null, image_url: null, epc: "code", stock_qty: 1 };
for (const name of ["SingleSkuCard", "SingleSkuRow"]) {
  test(`${name} displays enrollment below product and honors explicit exclusion`, () => {
    const html = (extra = {}) => renderToStaticMarkup(createElement(module.exports[name], { row: { ...row, ...extra } }));
    assert.ok(html().includes("翻筐乐"));
    assert.ok(html().indexOf("翻筐乐") > html().indexOf("code"));
    assert.ok(!html({ fankuang_override: false }).includes("翻筐乐"));
    assert.ok(html({ price_tier: 199, fankuang_override: true }).includes("翻筐乐"));
    assert.ok(!html({ kind: "bundle" }).includes("翻筐乐"));
  });
}
test("PC query has independent filter identity and PostgreSQL filtering before limit", async () => {
  const route = readFileSync("src/routes/inventory.skus.index.tsx", "utf8");
  const server = readFileSync("src/lib/inventory.functions.ts", "utf8");
  assert.match(route, /queryKey: \["inv-skus", search, onlyFankuang\]/);
  assert.match(route, /aria-pressed=\{onlyFankuang\}/);
  assert.match(server, /if \(data\.fankuang\) q = q\.or\(FANKUANG_POSTGREST_FILTER\)/);
  const rule = await import("./fankuang.ts");
  let requested: URL | undefined;
  const db = createClient("https://list-test.invalid", "fixture", { global: { fetch: async (url) => {
    requested = new URL(String(url)); return Response.json([]);
  } } });
  await db.from("inv_skus").select("*").or(rule.FANKUANG_POSTGREST_FILTER).limit(1);
  assert.ok(requested?.searchParams.get("or")?.includes("fankuang_override.eq.true"));
  assert.ok(requested?.searchParams.get("or")?.includes("fankuang_override.is.null,price_tier.gt.0,price_tier.lte.49.9"));
  assert.ok(requested?.searchParams.get("or")?.includes("inventory_policy.neq.unlimited"));
  assert.equal(requested?.searchParams.get("limit"), "1");
});
