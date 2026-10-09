import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import {
  AI_POLICY_VERSION,
  handleConsentRead,
  handleConsentWrite,
  isAiAllowed,
  queuedAiDecision,
  type ConsentStore,
} from "./ai-consent-core.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

function memStore() {
  const rows = new Map<string, boolean>();
  const writes: string[] = [];
  const store: ConsentStore = {
    get: async (u, v) => rows.get(`${u}:${v}`) ?? null,
    set: async (u, v, a) => { writes.push(`${u}:${v}:${a}`); rows.set(`${u}:${v}`, a); return a; },
  };
  return { store, rows, writes };
}

// ---------- contract ----------
test("anonymous (no employee session) read/write returns 401 and writes nothing", async () => {
  const { store, writes } = memStore();
  const w = await handleConsentWrite({ store, userId: null, deviceId: "d", raw: { allowed: true, policy_version: AI_POLICY_VERSION } });
  assert.equal(w.status, 401);
  assert.equal(w.body.code, "session_required");
  assert.equal((await handleConsentRead({ store, userId: null })).status, 401);
  assert.deepEqual(writes, []);
});

test("cross-account: body cannot name another user; user_id comes only from session", async () => {
  const { store, writes } = memStore();
  const spoof = await handleConsentWrite({ store, userId: "me", deviceId: "d",
    raw: { allowed: true, policy_version: AI_POLICY_VERSION, user_id: "victim" } });
  assert.equal(spoof.status, 422);
  assert.deepEqual(writes, []);
  const okRes = await handleConsentWrite({ store, userId: "me", deviceId: "d", raw: { allowed: true, policy_version: AI_POLICY_VERSION } });
  assert.equal(okRes.status, 200);
  assert.deepEqual(writes, [`me:${AI_POLICY_VERSION}:true`]);
  assert.equal(await isAiAllowed(store, "victim", AI_POLICY_VERSION), false);
});

test("version: stale client version rejected with 409; old-version consent does not authorize AI", async () => {
  const { store, rows } = memStore();
  const r = await handleConsentWrite({ store, userId: "me", deviceId: "d", raw: { allowed: true, policy_version: "2026-01-01-v1" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "policy_version_mismatch");
  rows.set("me:2026-01-01-v1", true);
  assert.equal(await isAiAllowed(store, "me", AI_POLICY_VERSION), false);
  assert.equal(await isAiAllowed(store, "me", "2026-01-01-v1"), false);
});

test("consent then revoke: response mirrors stored value, revoke turns AI off", async () => {
  const { store } = memStore();
  const a = await handleConsentWrite({ store, userId: "me", deviceId: "d", raw: { allowed: true, policy_version: AI_POLICY_VERSION } });
  assert.deepEqual(a.body, { ok: true, data: { allowed: true, policy_version: AI_POLICY_VERSION } });
  assert.equal(await isAiAllowed(store, "me", AI_POLICY_VERSION), true);
  const b = await handleConsentWrite({ store, userId: "me", deviceId: "d", raw: { allowed: false, policy_version: AI_POLICY_VERSION } });
  assert.deepEqual(b.body, { ok: true, data: { allowed: false, policy_version: AI_POLICY_VERSION } });
  assert.equal(await isAiAllowed(store, "me", AI_POLICY_VERSION), false);
  assert.deepEqual((await handleConsentRead({ store, userId: "me" })).body, { ok: true, data: { allowed: false, policy_version: AI_POLICY_VERSION } });
});

test("store failures are errors, never fake success", async () => {
  const broken: ConsentStore = { get: async () => { throw new Error("x"); }, set: async () => { throw new Error("x"); } };
  const w = await handleConsentWrite({ store: broken, userId: "me", deviceId: "d", raw: { allowed: true, policy_version: AI_POLICY_VERSION } });
  assert.equal(w.status, 503);
  assert.equal(w.body.ok, false);
  assert.equal((await handleConsentRead({ store: broken, userId: "me" })).status, 503);
  assert.equal(await queuedAiDecision(broken, { ai_actor_user_id: "me", ai_policy_version: AI_POLICY_VERSION }), "unavailable");
});

test("queued jobs: null actor (legacy) and wrong version are denied", async () => {
  const { store, rows } = memStore();
  rows.set(`me:${AI_POLICY_VERSION}`, true);
  assert.equal(await queuedAiDecision(store, { ai_actor_user_id: null, ai_policy_version: null }), "denied");
  assert.equal(await queuedAiDecision(store, { ai_actor_user_id: "me", ai_policy_version: "old" }), "denied");
  assert.equal(await queuedAiDecision(store, { ai_actor_user_id: "me", ai_policy_version: AI_POLICY_VERSION }), "allowed");
});

test("retry with different ai_processing_allowed keeps the same product fingerprint (no duplicate SKU)", async () => {
  const { smartCreateFingerprint } = await bundle("src/server/handheld-smart-create.server.ts", {
    "@/integrations/supabase/client.server": "export const supabaseAdmin = {};",
    "@/lib/product-classification": "export const findSanrioBrandCandidate = () => null;",
    "@/lib/product-taxonomy": "export const matchBrandCandidate = () => null; export const normalizeLookupText = s => s;",
    "./product-classification.server": "export const loadActiveProductBrands = async () => []; export const loadActiveProductIps = async () => [];",
  });
  const base = { name: "屋", category: "toy", price_tier: 159, client_op_id: "c1" };
  const a = smartCreateFingerprint({ ...base, ai_processing_allowed: true }, "loc");
  const b = smartCreateFingerprint({ ...base, ai_processing_allowed: false, client_op_id: "c2" }, "loc");
  const c = smartCreateFingerprint(base, "loc");
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, smartCreateFingerprint({ ...base, name: "别的" }, "loc"));
});

// ---------- queue worker: revocation after enqueue ----------
const q: any = { consent: {}, prepared: 0, finishes: [], jobs: [] };
(globalThis as any).__aiq = q;
async function bundle(entry: string, stubs: Record<string, string>, real: string[] = []) {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "stubs", setup(b: any) {
      b.onResolve({ filter: /^(@\/|@tanstack\/react-router$|\.\/product-classification\.server$)/ }, (a: any) => real.includes(a.path)
        ? { path: require.resolve(a.path.replace(/^@\//, "/dev-server/src/") + ".ts") }
        : { path: a.path, namespace: "stub" });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => {
        assert.ok(stubs[a.path] !== undefined, `unhandled import ${a.path}`);
        return { contents: stubs[a.path], loader: "js" };
      });
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const consentStoreStub = `export const dbConsentStore = () => ({ get: async (u, v) => globalThis.__aiq.consent[u + ':' + v] ?? null });`;
const worker = await bundle("src/server/handheld-listing-image-jobs.server.ts", {
  "@/integrations/supabase/client.server": `export const supabaseAdmin = {
    rpc: async (name, args) => { const s = globalThis.__aiq;
      if (name === 'handheld_listing_image_claim') return { data: s.jobs.splice(0), error: null };
      if (name === 'product_content_image_claim') return { data: [], error: null };
      s.finishes.push(args); return { data: args.p_error ? 'retryable_failed' : 'succeeded', error: null }; },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://raw' }, error: null }),
      upload: async () => ({ error: null }) }) } };`,
  "@/server/handheld-ai.server": `export const aiPrepareListingImage = async () => { globalThis.__aiq.prepared++; return { b64: 'AA==', mime: 'image/png' }; };`,
  "@/server/listing-image-safety.server": `export const safeImageJobError = e => String(e && e.message || e);`,
  "@/server/ai-consent.server": consentStoreStub,
}, ["@/server/ai-consent-core"]);

beforeEach(() => { q.consent = {}; q.prepared = 0; q.finishes = []; q.jobs = []; });
const job = (extra: object) => ({ id: "j1", sku_id: "s1", source_bucket: "sku-raw", source_path: "a.jpg", source_index: 0,
  attempts: 1, claim_token: "t", ...extra });

test("queued job: consent revoked after enqueue => no AI call, original image kept (retryable error)", async () => {
  q.jobs = [job({ ai_actor_user_id: "u1", ai_policy_version: AI_POLICY_VERSION })]; // consent row absent/revoked
  await worker.runListingImageWorker(2);
  assert.equal(q.prepared, 0);
  assert.equal(q.finishes.length, 1);
  assert.match(q.finishes[0].p_error, /ai_consent_missing/);
  assert.equal(q.finishes[0].p_target_path, null);
});

test("queued job: legacy row without actor never reaches AI", async () => {
  q.consent = { [`u1:${AI_POLICY_VERSION}`]: true };
  q.jobs = [job({})];
  await worker.runListingImageWorker(2);
  assert.equal(q.prepared, 0);
});

test("queued job: actor still consents => exactly one AI call", async () => {
  q.consent = { [`u1:${AI_POLICY_VERSION}`]: true };
  q.jobs = [job({ ai_actor_user_id: "u1", ai_policy_version: AI_POLICY_VERSION })];
  await worker.runListingImageWorker(2);
  assert.equal(q.prepared, 1);
  assert.equal(q.finishes[0].p_error, null);
});

// ---------- synchronous AI route ----------
const route = await bundle("src/routes/api/public/handheld/ai.recognize-item.ts", {
  "@tanstack/react-router": "export const createFileRoute = () => o => o;",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS = {};
    export const authenticateDevice = async () => ({ ok: true, device: { id: 'dev' } });
    export const resolveSessionUser = async () => globalThis.__aiq.session;
    export const ok = d => Response.json({ ok: true, data: d });
    export const err = (m, s, x = {}) => Response.json({ ok: false, error: m, ...x }, { status: s });`,
  "@/integrations/supabase/client.server": `export const supabaseAdmin = { from: () => { const f = {}; const q = {
    select: () => q, eq: (k, v) => { f[k] = v; return q; },
    maybeSingle: async () => { const a = globalThis.__aiq.consent[f.user_id + ':' + f.policy_version];
      return { data: a === undefined ? null : { allowed: a }, error: null }; } }; return q; } };`,
  "@/lib/handheld/schemas": "export const AiRecognizeReq = { parse: v => v };",
  "@/server/handheld-ai.server": "export const aiRecognizeItem = async () => { globalThis.__aiq.prepared++; return { name: 'x' }; };",
}, ["@/server/ai-consent-core", "@/server/ai-consent.server"]);
const call = () => route.Route.server.handlers.POST({ request: new Request("https://x", { method: "POST", body: "{}" }) });

test("recognize-item: anonymous 401, no consent 403, consent 200; AI only called when allowed", async () => {
  q.session = null;
  assert.equal((await call()).status, 401);
  q.session = { user_id: "u1" };
  const denied = await call();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "ai_consent_required");
  assert.equal(q.prepared, 0);
  q.session = { user_id: "u2" };
  q.consent = { [`u1:${AI_POLICY_VERSION}`]: true }; // another user's consent does not carry over
  assert.equal((await call()).status, 403);
  q.session = { user_id: "u1" };
  assert.equal((await call()).status, 200);
  assert.equal(q.prepared, 1);
});
