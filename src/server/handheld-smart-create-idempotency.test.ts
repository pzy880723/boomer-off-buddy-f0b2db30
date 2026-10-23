import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

type Rpc = { name: string; args: Record<string, unknown> };
const state: {
  rpcs: Rpc[];
  commit: () => { data?: unknown; error?: { code?: string; message: string } };
  tables: Record<string, unknown>;
  finish: string[];
  releaseCalls: number;
  release: () => Promise<{ ok: boolean }>;
  legacy: unknown;
  failedTable: string | null;
} = {} as never;

function chain(table: string) {
  const q: any = {
    select: () => q, eq: () => q, update: (v: any) => { ((state as any).updates ??= []).push({ table, v }); return q; }, insert: () => q, upsert: () => q,
    maybeSingle: async () => state.failedTable === table
      ? { data: null, error: { message: "database unavailable" } }
      : { data: state.tables[table] ?? null, error: null },
    then: (r: any) => r({ data: null, error: null }),
  };
  return q;
}
const admin = {
  from: (t: string) => chain(t),
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpcs.push({ name, args });
    if (name === "handheld_smart_create_commit_v3") return state.commit();
    if (name === "handheld_release_outbox_claim")
      return { data: [{ id: "o1", sku_id: "s1", shop_id: "shop", location_id: "loc", claim_token: "t", attempts: 1 }], error: null };
    if (name === "handheld_release_outbox_finish") {
      state.finish.push(`${args.p_ok}:${args.p_cancel}:${args.p_error}`);
      return { data: args.p_cancel ? "cancelled" : args.p_ok ? "done" : "failed", error: null };
    }
    return { data: null, error: null };
  },
};
(globalThis as any).__sc = { admin, state };

async function load(entry: string, stubs: Record<string, string>) {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "stubs", setup(b: any) {
      b.onResolve({ filter: /^@/ }, (a: any) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => {
        assert.ok(stubs[a.path], `unhandled import ${a.path}`);
        return { contents: stubs[a.path], loader: "js" };
      });
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

const adminStub = "export const supabaseAdmin = globalThis.__sc.admin;";
const { Route } = await load("src/routes/api/public/handheld/items.smart-create.ts", {
  "@tanstack/react-router": "export const createFileRoute = () => o => o;",
  "@/server/listing-readiness.server": "export const advanceListingReadiness=async()=>({status:'legacy'}); export const advanceListingReadinessSafe=async()=>{}; export const currentReadinessRevision=async()=>null; export const sweepListingReadiness=async()=>({checked:0});",
  "@/lib/server-timing": "export const createServerTiming = () => ({ mark() {}, header: () => '', apply: r => { r.headers.set('Server-Timing', 'total;dur=0'); return r; } });",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS = {};
    export const authenticateDevice = async () => ({ ok: true, device: { id: "dev", device_code: "HH", location_id: "loc" } });
    export const resolveSessionUser = async () => ({ user_id: "u1" });
    export const userCanAccessLocation = async () => true;
    export const ok = d => Response.json({ ok: true, data: d });
    export const err = (m, s, x = {}) => Response.json({ message: m, ...x }, { status: s });`,
  "@/integrations/supabase/client.server": adminStub,
  "@/lib/handheld/schemas": "export const SmartCreateReq = { parse: v => ({ auto_push_youzan: true, is_custom_price: true, attributes: {}, ...v }) };",
  "@/lib/inventory.helpers": "export const generateEpc = () => 'E'; export const generateSkuCode = () => 'S';",
  "@/server/handheld-print.server": "export const buildPrintPayload = () => ({});",
  "@/server/handheld-idempotency.server": `export const replayIfPresent = async () => globalThis.__sc.state.legacy; export const recordOp = async () => {};
    export const jsonReplay = r => Response.json({ ...r.response_json, replayed: true }, { status: r.response_status });`,
  "@/server/handheld-smart-create.server": `export const getSmartCreateReleaseTarget = i => i.autoPushYouzan && i.locationKind === 'shop' ? i.shopId : null;
    export const resolveConfirmedListingBrand = async () => null;
    export const persistSmartCreateBrand = async () => {}; export const shouldReuseSmartCreateSku = c => !c;
    export const smartCreateFingerprint = () => 'fp';
    export const smartCreateRequestFingerprint = b => ({ fingerprint: 'fp', incomingPaths: (b.image_storage_paths ?? []).map(p => p.storage_path.startsWith(p.bucket + '/') ? p.storage_path : p.bucket + '/' + p.storage_path), normalizedImageUrl: null });`,
  "@/lib/commerce/product-marks": "export const readProductMarks = s => ({ featured_stamp: s?.featured_stamp ?? null, notice_tags: s?.notice_tags ?? [] });",
  "@/server/product-classification.server": `export const assertActiveLeafCategory = async () => {}; export const attachProductClassificationAuditToSku = async () => {};
    export const replaceManualProductFacets = async () => {}; export const resolveOrCreateConfirmedIp = async (i) => { (globalThis.__sc.state.ipCalls ??= []).push(['confirm', i]); if (i.name && !i.confirmed) throw new Error('IP 未确认，请选择已有 IP 或确认新建'); return { id: null, name: null, status: 'empty' }; }; export const resolveIpCandidate = async (n) => { (globalThis.__sc.state.ipCalls ??= []).push(['candidate', n]); return n === '哆啦A梦' ? { id: 'ip1', name: '哆啦A梦', status: 'matched' } : { id: null, name: n, status: 'review' }; };
    export const resolveManualProductFacets = async () => null;`,
  "@/server/handheld-listing-image-jobs.server": "export const enqueueListingImageJobs = async (i) => { globalThis.__sc.state.enqueued.push(i); return { status: 'queued', queued: 1 }; }; export const triggerListingImageWorker = () => {};",
  "@/server/ai-consent.server": "export const dbConsentStore = () => ({ get: async (u, v) => { if (globalThis.__sc.state.consentThrows) throw Error('down'); return globalThis.__sc.state.consent[u + ':' + v] ?? null; } });",
  "@/server/ai-consent-core": `export const AI_POLICY_VERSION = "2026-10-09-v1";
    export const isAiAllowed = async (s, u, v) => !!u && v === AI_POLICY_VERSION && (await s.get(u, v)) === true;
    export const smartCreateWantsAi = f => f !== false;`,
});
const { runHandheldReleaseWorker } = await load("src/server/handheld-release-outbox.server.ts", {
  "@/integrations/supabase/client.server": adminStub,
  "@/lib/youzan-offline-products.functions": "export const releaseSkuToOfflineShopsCore = () => { throw Error('use injected deps'); };",
  "@/lib/youzan-category-groups.server": "export const assignSkuToYouzanCategoryGroups = async () => {};",
});

beforeEach(() => {
  state.legacy = null; state.failedTable = null;
  state.rpcs = []; state.finish = []; state.releaseCalls = 0;
  (state as any).updates = []; (state as any).enqueued = []; (state as any).consent = {}; (state as any).consentThrows = false;
  state.tables = { inv_locations: { id: "loc", name: "新天地", kind: "shop", shop_id: "shop", is_active: true }, inv_skus: { status: "active", image_paths: [], barcode: "200" }, inv_stocks: { qty: 1 } };
  state.commit = () => ({ data: { op_id: "op", replayed: false, op_status: "committed", sku_id: "s1", sku_code: "S", epc: "E", bound_epcs: 0, stock_qty: 1, response: null } });
  state.release = async () => ({ ok: true });
});
const post = (body: object = { client_op_id: "c1", category: "toy", name: "屋", price_tier: 159 }) =>
  Route.server.handlers.POST({ request: new Request("https://x/api", { method: "POST", body: JSON.stringify(body) }) });

test("first submit commits atomically, queues Youzan release and returns without publishing inline", async () => {
  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.youzan_sync_status, "queued");
  const commit = state.rpcs.find((r) => r.name === "handheld_smart_create_commit_v3")!;
  assert.equal(commit.args.p_release_shop_id, "shop");
  assert.equal(commit.args.p_user_id, "u1");
  assert.equal(commit.args.p_location_id, "loc");
  assert.ok(state.rpcs.some((r) => r.name === "handheld_smart_create_complete"));
});

test("payload/user/location conflict on the same client_op_id returns 409", async () => {
  state.commit = () => ({ error: { code: "P0409", message: "client_op_id_conflict" } });
  const res = await post();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "client_op_id_conflict");
});

test("legacy response cannot bypass the new operation fingerprint and actor check", async () => {
  state.tables.handheld_smart_create_ops = { user_id: "another", location_id: "loc", payload_fingerprint: "fp" };
  state.legacy = { response_status: 200, response_json: { ok: true, data: { sku_id: "old" } } };
  const res = await post();
  assert.equal(res.status, 409);
});

test("retry after timeout replays the stored response and performs no further writes", async () => {
  state.commit = () => ({ data: { op_id: "op", replayed: true, op_status: "completed", sku_id: "s1", epc: "E", bound_epcs: 0, stock_qty: 1, response: { ok: true, data: { sku_id: "s1" } } } });
  const res = await post();
  const body = await res.json();
  assert.equal(body.data.sku_id, "s1");
  assert.equal(body.replayed, true);
  assert.equal(state.rpcs.length, 1);
});

test("retry of a committed-but-unfinished op resumes post steps with the original SKU", async () => {
  state.commit = () => ({ data: { op_id: "op", replayed: true, op_status: "committed", sku_id: "s1", sku_code: "S", epc: "E", bound_epcs: 0, stock_qty: 1, response: null } });
  const body = await (await post()).json();
  assert.equal(body.data.sku_id, "s1");
  assert.ok(state.rpcs.some((r) => r.name === "handheld_smart_create_complete"));
});

const deps = { release: async () => { state.releaseCalls++; return state.release(); }, assignGroups: async () => {} };
test("worker marks success done", async () => {
  const r = await runHandheldReleaseWorker(1, deps);
  assert.deepEqual(r.outcomes.map((o: any) => o.status), ["done"]);
});
test("worker background failure is retried with backoff, never thrown to the caller", async () => {
  state.release = async () => { throw new Error("youzan upload timeout"); };
  const r = await runHandheldReleaseWorker(1, deps);
  assert.deepEqual(r.outcomes.map((o: any) => o.status), ["failed"]);
  assert.match(state.finish[0], /^false:false:youzan upload timeout/);
});
test("worker cancels archived or zero-stock SKUs instead of publishing", async () => {
  state.tables.inv_skus = { status: "archived" };
  const r = await runHandheldReleaseWorker(1, deps);
  assert.equal(state.releaseCalls, 0);
  assert.deepEqual(r.outcomes.map((o: any) => o.status), ["cancelled"]);
});

test("temporary database read failure retries rather than permanently cancelling publication", async () => {
  state.failedTable = "inv_stocks";
  const result = await runHandheldReleaseWorker(1, deps);
  assert.equal(state.releaseCalls, 0);
  assert.deepEqual(result.outcomes.map((o: any) => o.status), ["failed"]);
});

// ---- AI consent (2026-10-09-v1) ----
const withImage = (extra: object = {}) => ({ client_op_id: "c2", category: "toy", name: "屋", price_tier: 159,
  image_storage_paths: [{ bucket: "sku-raw", storage_path: "2026-10-09/dev/a.jpg" }], ...extra });

const commitArgs = () => state.rpcs.find((r) => r.name === "handheld_smart_create_commit_v3")!.args;
const noPostCommitSettle = () =>
  assert.ok(!state.rpcs.some((r) => r.name === "listing_readiness_mark_images_settled"), "no implicit raw settle after commit");

test("ai_processing_allowed=false: explicit decline persisted in the commit tx, never queues AI", async () => {
  (state as any).consent = { "u1:2026-10-09-v1": true };
  const res = await post(withImage({ ai_processing_allowed: false }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ai_processing, "skipped_by_client");
  assert.equal(commitArgs().p_image_plan, "raw_declined");
  assert.equal((state as any).enqueued.length, 0);
  noPostCommitSettle();
});

test("missing consent row is NOT a refusal: plan stays pending_consent for the worker sweep", async () => {
  const res = await post(withImage({ ai_processing_allowed: true }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.ai_processing, "consent_required");
  assert.equal(commitArgs().p_image_plan, "pending_consent");
  assert.equal(commitArgs().p_user_id, "u1");
  assert.equal((state as any).enqueued.length, 0);
  noPostCommitSettle();
});

test("stored explicit refusal (allowed=false) uses original photos", async () => {
  (state as any).consent = { "u1:2026-10-09-v1": false };
  const res = await post(withImage());
  assert.equal((await res.json()).data.ai_processing, "consent_required");
  assert.equal(commitArgs().p_image_plan, "raw_declined");
});

test("consent read failure: pending_consent, reports unavailable (no fake success, no raw release)", async () => {
  (state as any).consentThrows = true;
  const res = await post(withImage({ ai_processing_allowed: true }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.ai_processing, "consent_unavailable");
  assert.equal(commitArgs().p_image_plan, "pending_consent");
  noPostCommitSettle();
});

test("with consent the commit tx carries the session actor and policy; no post-commit enqueue", async () => {
  (state as any).consent = { "u1:2026-10-09-v1": true };
  state.commit = () => ({ data: { op_id: "op", replayed: false, op_status: "committed", sku_id: "s1", sku_code: "S", epc: "E",
    bound_epcs: 0, stock_qty: 1, response: null, image_plan: "ai", image_jobs_open: 1 } });
  const res = await post(withImage({ ai_processing_allowed: true }));
  const body = await res.json();
  assert.equal(body.data.ai_processing, "allowed");
  assert.equal(body.data.image_processing.queued, 1);
  assert.equal(commitArgs().p_image_plan, "ai");
  assert.equal(commitArgs().p_user_id, "u1");
  assert.equal(commitArgs().p_ai_policy, "2026-10-09-v1");
  assert.equal((state as any).enqueued.length, 0);
});

// ---- post-commit photo merge (0082 route fix) ----
const skuImageWrites = () => (state as any).updates.filter((u: any) => u.table === "inv_skus" && "image_paths" in u.v);

test("new custom SKU: worker already replaced raw → post-commit never re-adds input raw", async () => {
  state.tables.inv_skus = { status: "active", image_paths: ["sku-listing/gallery/s1/done.png"], barcode: "200" };
  const res = await post(withImage({ is_custom_price: true }));
  assert.equal(res.status, 200);
  assert.equal(skuImageWrites().length, 0);
  assert.equal(commitArgs().p_reuse, false);
});

test("new custom SKU with recognition: attribute update still omits image_paths", async () => {
  state.tables.inv_skus = { status: "active", image_paths: ["sku-listing/gallery/s1/done.png"], barcode: "200" };
  await post(withImage({ is_custom_price: true, recognition_request_id: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(skuImageWrites().length, 0);
});

test("standard reuse: photos go only through the commit transaction, route never writes image_paths", async () => {
  state.tables.inv_skus = { status: "active", image_paths: ["sku-listing/old.png"], barcode: "200" };
  await post(withImage({ is_custom_price: false }));
  assert.equal(skuImageWrites().length, 0);
  assert.equal(commitArgs().p_reuse, true);
  assert.deepEqual((commitArgs().p_sku as { image_paths: string[] }).image_paths, ["sku-raw/2026-10-09/dev/a.jpg"]);
});

test("standard reuse after worker finished: HTTP follow-up does not resurrect raw", async () => {
  state.tables.inv_skus = { status: "active", image_paths: ["sku-listing/old.png", "sku-listing/gallery/a.png"], barcode: "200" };
  await post(withImage({ is_custom_price: false, recognition_request_id: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(skuImageWrites().length, 0);
});

test("tombstoned op: stored cancelled row returns 409 client_op_cancelled and never commits", async () => {
  state.tables.handheld_smart_create_ops = { user_id: "u1", location_id: "loc", payload_fingerprint: "fp", response_json: null, status: "cancelled" };
  const res = await post();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "client_op_cancelled");
  assert.equal(state.rpcs.some((r) => r.name === "handheld_smart_create_commit_v3"), false);
});

test("late original request racing a cancel: DB P0410 maps to 409 client_op_cancelled", async () => {
  state.commit = () => ({ error: { code: "P0410", message: "client_op_cancelled" } });
  const res = await post();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "client_op_cancelled");
});

test("marks are sent to the commit only when the client provided them", async () => {
  await post();
  assert.equal(commitArgs().p_marks, null);
  state.rpcs = [];
  await post({ client_op_id: "c2", category: "toy", name: "屋", price_tier: 159, featured_stamp: "rare", notice_tags: ["parts_missing"] });
  assert.deepEqual(commitArgs().p_marks, { featured_stamp: "rare", notice_tags: ["parts_missing"] });
  state.rpcs = [];
  await post({ client_op_id: "c3", category: "toy", name: "屋", price_tier: 159, featured_stamp: null, notice_tags: [] });
  assert.deepEqual(commitArgs().p_marks, { featured_stamp: null, notice_tags: [] });
});

// ---- ip_candidate（新版未确认 IP 不挡上架） ----
const ipBase = { client_op_id: "c9", category: "toy", name: "屋", price_tier: 159, ip_confirmed: false };
test("旧客户端：陌生 ip_name + 未确认仍 422，不建 SKU", async () => {
  (state as any).ipCalls = [];
  const res = await post({ ...ipBase, ip_name: "陌生IP" });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "ip_confirmation_required");
  assert.ok(!state.rpcs.some((r) => r.name === "handheld_smart_create_commit_v3"));
});
test("ip_candidate 陌生：照常建 SKU，ip_id null，候选原文待核对，不创建全局 IP", async () => {
  (state as any).ipCalls = [];
  const res = await post({ ...ipBase, ip_candidate: "陌生IP" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ip_review_pending, true);
  const sku = commitArgs().p_sku as any;
  assert.equal(sku.ip_id, null); assert.equal(sku.ip_candidate_text, "陌生IP");
  assert.deepEqual((state as any).ipCalls, [["candidate", "陌生IP"]]);
  assert.ok(!(state as any).updates.some((u: any) => u.table === "inv_brands"));
});
test("ip_candidate 命中已启用 IP：关联且不待核对", async () => {
  const body = await (await post({ ...ipBase, ip_candidate: "哆啦A梦" })).json();
  assert.equal(body.data.ip_review_pending, false);
  assert.equal((commitArgs().p_sku as any).ip_id, "ip1");
});
test("ip_candidate 与 ip_name 或 ip_confirmed=true 同传 → 400", async () => {
  assert.equal((await post({ ...ipBase, ip_candidate: "x", ip_name: "y" })).status, 400);
  assert.equal((await post({ ...ipBase, ip_candidate: "x", ip_confirmed: true })).status, 400);
});
test("省略 ip_candidate 时回执不含 ip_review_pending", async () => {
  const body = await (await post({ ...ipBase })).json();
  assert.equal("ip_review_pending" in body.data, false);
});
