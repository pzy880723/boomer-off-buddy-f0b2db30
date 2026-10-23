import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundle = await build({
  entryPoints: ["src/server/handheld-smart-create.server.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "stubs", setup(b: any) {
    b.onResolve({ filter: /^@\/(integrations|server|lib\/product-)/ }, (a: any) => ({ path: a.path, namespace: "stub" }));
    b.onResolve({ filter: /^@\/lib\/commerce\/product-marks$/ }, () => ({ path: new URL("../lib/commerce/product-marks.ts", import.meta.url).pathname }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const supabaseAdmin={}; export const findSanrioBrandCandidate=()=>null; export const matchBrandCandidate=()=>null; export const normalizeLookupText=s=>s; export const loadActiveProductBrands=async()=>[]; export const loadActiveProductIps=async()=>[];", loader: "js" }));
  } }],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function legacyFingerprint(body: Record<string, unknown>, loc: string) {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as any)[k])])) : v;
  const { client_op_id: _a, ai_processing_allowed: _b, ...rest } = body;
  return createHash("sha256").update(JSON.stringify(canonical({ ...rest, location_id: loc }))).digest("hex");
}
const base = { category: "toy", name: "屋", price_tier: 159, is_custom_price: true, attributes: {}, auto_push_youzan: false, client_op_id: "c1" };

test("omitted marks keep the exact legacy fingerprint (no null/[] injected)", () => {
  assert.equal(m.smartCreateFingerprint({ ...base }, "loc"), legacyFingerprint({ ...base }, "loc"));
  assert.equal(m.smartCreateRequestFingerprint({ ...base }, "loc").fingerprint, legacyFingerprint({ ...base, image_url: null }, "loc"));
});

test("marks are part of the fingerprint; tag order is normalized; changing marks conflicts", () => {
  const a = m.smartCreateFingerprint({ ...base, notice_tags: ["parts_missing", "flawed"] }, "loc");
  const b = m.smartCreateFingerprint({ ...base, notice_tags: ["flawed", "parts_missing"] }, "loc");
  assert.equal(a, b);
  assert.notEqual(a, m.smartCreateFingerprint({ ...base }, "loc"));
  assert.notEqual(m.smartCreateFingerprint({ ...base, featured_stamp: "rare" }, "loc"), m.smartCreateFingerprint({ ...base, featured_stamp: null }, "loc"));
  assert.notEqual(m.smartCreateFingerprint({ ...base, notice_tags: [] }, "loc"), m.smartCreateFingerprint({ ...base }, "loc"));
});
