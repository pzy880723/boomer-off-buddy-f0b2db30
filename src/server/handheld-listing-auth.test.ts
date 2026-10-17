import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
let session: { user_id: string } | null;
let allowed: boolean;
let checkedLocation: string | undefined;
let classificationCalls: number;
const context = {
  authenticateDevice: async () => ({ ok: true, device: { id: "device", location_id: "old-store" } }),
  resolveSessionUser: async () => session,
  userCanAccessLocation: async (_user: string, location: string) => {
    checkedLocation = location;
    return allowed;
  },
  err: (message: string, status: number, extra: object = {}) => Response.json({ message, ...extra }, { status }),
  assertActiveLeafCategory: async () => { classificationCalls++; throw new Error("authorized-boundary"); },
};
(globalThis as any).__listingAuthTest = context;
const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => options => options;",
  // 路由新增的计时与 AI 授权依赖：鉴权失败/分类前即返回，任何 AI 授权查询都视为越界。
  "@/server/listing-readiness.server": "export const advanceListingReadiness=async()=>({status:'legacy'}); export const advanceListingReadinessSafe=async()=>{}; export const currentReadinessRevision=async()=>null; export const sweepListingReadiness=async()=>({checked:0});",
  "@/lib/server-timing": "export const createServerTiming = () => ({ mark() {}, apply: response => response });",
  "@/server/ai-consent.server": "export const dbConsentStore = () => {throw Error('unexpected consent lookup')};",
  "@/server/ai-consent-core": "export const AI_POLICY_VERSION = 'test'; export const isAiAllowed = () => {throw Error('unexpected consent check')}; export const smartCreateWantsAi = () => {throw Error('unexpected AI branch')};",
  "@/server/handheld-auth.server": `export const { authenticateDevice, resolveSessionUser, userCanAccessLocation, err } = globalThis.__listingAuthTest; export const HANDHELD_CORS = {}; export const ok = () => {};`,
  // 路由并行预读（Promise.allSettled）会构造查询；任何查询执行都异步拒绝，绝不返回数据。
  "@/integrations/supabase/client.server": "const q = new Proxy(function(){}, {get: (_t, k) => k === 'then' ? undefined : (k === 'maybeSingle' || k === 'single') ? async () => {throw Error('unexpected database access')} : () => q, apply: () => q}); export const supabaseAdmin = { from: () => q, rpc: async () => {throw Error('unexpected database access')} };",
  "@/lib/handheld/schemas": "export const SmartCreateReq = {parse: value => value};",
  "@/lib/inventory.helpers": "export const generateEpc = () => {}; export const generateSkuCode = () => {};",
  "@/server/handheld-print.server": "export const buildPrintPayload = () => {};",
  "@/server/handheld-idempotency.server": "export const replayIfPresent = () => {throw Error('unexpected replay')}; export const recordOp = () => {}; export const jsonReplay = () => {};",
  "@/server/handheld-smart-create.server": "export const getSmartCreateReleaseTarget = () => {}; export const resolveConfirmedListingBrand = async () => {throw Error('unexpected brand write')}; export const persistSmartCreateBrand = () => {}; export const shouldReuseSmartCreateSku = () => {}; export const smartCreateFingerprint = () => \"fp\";",
  "@/server/product-classification.server": "export const {assertActiveLeafCategory} = globalThis.__listingAuthTest; export const attachProductClassificationAuditToSku = () => {}; export const replaceManualProductFacets = () => {}; export const resolveOrCreateConfirmedIp = () => {throw Error('unexpected IP write')}; export const resolveManualProductFacets = () => {};",
  "@/server/handheld-listing-image-jobs.server": "export const enqueueListingImageJobs = () => {}; export const triggerListingImageWorker = () => {};",
  "@/lib/youzan-offline-products.functions": "export const releaseSkuToOfflineShopsCore = () => {throw Error('unexpected publish')};",
  "@/lib/youzan-category-groups.server": "export const assignSkuToYouzanCategoryGroups = () => {};",
};
const bundle = await build({
  entryPoints: ["src/routes/api/public/handheld/items.smart-create.ts"],
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "auth-boundaries", setup(builder: any) {
    builder.onResolve({ filter: /^@/ }, (args: any) => ({ path: args.path, namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => {
      assert.ok(stubs[args.path], `unhandled import ${args.path}`);
      return { contents: stubs[args.path] };
    });
  } }],
});
const { Route } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
beforeEach(() => { session = null; allowed = false; checkedLocation = undefined; classificationCalls = 0; });
const submit = (body: object = { location_id: "xintiandi" }) => Route.server.handlers.POST({
  request: new Request("https://erp.invalid/api/public/handheld/items/smart-create", { method: "POST", body: JSON.stringify(body) }),
});
test("device-only listing is denied before IP, SKU, stock or Youzan writes", async () => {
  assert.equal((await submit()).status, 401);
  assert.equal(classificationCalls, 0);
});
test("employee cannot submit to a foreign location", async () => {
  session = { user_id: "staff" };
  assert.equal((await submit()).status, 403);
  assert.equal(checkedLocation, "xintiandi");
  assert.equal(classificationCalls, 0);
});
test("authorized location proceeds to normal validation without using stale device location", async () => {
  session = { user_id: "staff" }; allowed = true;
  const response = await submit();
  assert.equal(response.status, 422);
  assert.equal((await response.json()).message, "authorized-boundary");
  assert.equal(checkedLocation, "xintiandi");
  assert.equal(classificationCalls, 1);
});
test("legacy device location is also authorized when body omits location", async () => {
  session = { user_id: "staff" };
  assert.equal((await submit({})).status, 403);
  assert.equal(checkedLocation, "old-store");
  assert.equal(classificationCalls, 0);
});
