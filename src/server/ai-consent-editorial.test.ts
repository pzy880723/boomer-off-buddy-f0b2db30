import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AI_POLICY_VERSION, handheldAiGuard, isAiConsentRevoked, webErpAiGuard } from "./ai-guard.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundled = await build({
  entryPoints: ["src/server/handheld-editorial.server.ts"],
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "editorial-test-io", setup(build: any) {
    build.onResolve({ filter: /^@\/(integrations\/supabase\/client\.server|lib\/sku-media)$/ }, (args: any) => ({
      path: args.path, namespace: "editorial-test-io",
    }));
    build.onLoad({ filter: /.*/, namespace: "editorial-test-io" }, (args: any) => ({
      contents: args.path.endsWith("sku-media")
        ? 'export const getPublicOrigin = () => "https://example.invalid"; export const resolvePublicSkuImageUrls = () => [];'
        : 'export const supabaseAdmin = { from: table => globalThis.__editorialTest.from(table) };',
      loader: "js",
    }));
  } }],
});
const { generateEditorialForSku } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

async function scenario(options: { allowed?: boolean; revokeWhileLoading?: boolean; unavailable?: boolean; web?: boolean; missing?: boolean }) {
  let allowed = options.allowed ?? true;
  let calls = 0;
  let writes = 0;
  const globals = globalThis as any;
  const previousFixture = globals.__editorialTest;
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.LOVABLE_API_KEY;
  globals.__editorialTest = { from(table: string) {
    let inserting = false;
    const chain = {
      select() { return chain; }, eq() { return chain; },
      async maybeSingle() {
        if (table !== "inv_skus") return { data: null, error: null };
        if (options.revokeWhileLoading) allowed = false;
        return { data: { id: "fixture-sku", name: "Fixture cup", is_custom_price: true,
          inventory_policy: "finite", attributes: {}, image_paths: [] }, error: null };
      },
      insert() { inserting = true; writes++; return chain; },
      async single() {
        assert.ok(inserting);
        return { data: { id: "fixture-article", slug: "fixture", title: "Fixture",
          summary: "Fixture", status: "pending_review", cover_url: null }, error: null };
      },
      async upsert() { writes++; return { error: null }; },
    };
    return chain;
  } };
  process.env.LOVABLE_API_KEY = "editorial-test-only";
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://ai.gateway.lovable.dev/v1/chat/completions");
    calls++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      title: "Fixture", summary: "Fixture", body: "Fixture story", keywords: [],
    }) } }] });
  }) as typeof fetch;
  const guard = options.missing ? undefined : options.web ? webErpAiGuard() : handheldAiGuard({
    async get() { if (options.unavailable) throw new Error("fixture read failed"); return allowed; },
    async set() { return true; },
  }, { userId: "fixture-staff", policyVersion: AI_POLICY_VERSION });
  try {
    if (options.revokeWhileLoading || options.allowed === false || options.unavailable || options.web || options.missing) {
      await assert.rejects(generateEditorialForSku({ skuId: "fixture-sku", publish: false }, guard), isAiConsentRevoked);
      assert.equal(calls, 0, "revoked content must not reach the AI gateway");
      assert.equal(writes, 0, "denied generation must not publish or save an article");
    } else {
      const result = await generateEditorialForSku({ skuId: "fixture-sku", publish: false }, guard);
      assert.equal(result.reused, false);
      assert.equal(calls, 1);
      assert.equal(writes, 2);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = previousKey;
    if (previousFixture === undefined) delete globals.__editorialTest;
    else globals.__editorialTest = previousFixture;
  }
}

test("editorial: revocation while SKU loads prevents sending content", () => scenario({ revokeWhileLoading: true }));
test("editorial: denied consent sends no content", () => scenario({ allowed: false }));
test("editorial: unavailable consent fails closed", () => scenario({ unavailable: true }));
test("editorial: a PC guard cannot replace the handheld staff actor", () => scenario({ web: true }));
test("editorial: a missing guard fails closed", () => scenario({ missing: true }));
test("editorial: allowed staff can still generate and save content", () => scenario({}));
test("editorial route forwards the session guard and maps consent errors", () => {
  const route = readFileSync("src/routes/api/public/handheld/content.generate-from-sku.ts", "utf8");
  assert.match(route, /generateEditorialForSku\([\s\S]*?auth\.guard\)/);
  assert.match(route, /aiConsentErrorResponse\(e\)/);
});
