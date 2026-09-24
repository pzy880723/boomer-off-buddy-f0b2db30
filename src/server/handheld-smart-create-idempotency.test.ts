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
    select: () => q, eq: () => q, update: () => q, insert: () => q, upsert: () => q,
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
    if (name === "handheld_smart_create_commit") return state.commit();
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
    export const persistSmartCreateBrand = async () => {}; export const shouldReuseSmartCreateSku = c => !c;
    export const smartCreateFingerprint = () => 'fp';`,
  "@/server/product-classification.server": `export const assertActiveLeafCategory = async () => {}; export const attachProductClassificationAuditToSku = async () => {};
    export const replaceManualProductFacets = async () => {}; export const resolveOrCreateConfirmedIp = async () => ({ id: null, name: null, status: 'none' });
    export const resolveManualProductFacets = async () => null;`,
  "@/server/handheld-listing-image-jobs.server": "export const enqueueListingImageJobs = async () => ({ status: 'idle', queued: 0 }); export const triggerListingImageWorker = () => {};",
});
const { runHandheldReleaseWorker } = await load("src/server/handheld-release-outbox.server.ts", {
  "@/integrations/supabase/client.server": adminStub,
  "@/lib/youzan-offline-products.functions": "export const releaseSkuToOfflineShopsCore = () => { throw Error('use injected deps'); };",
  "@/lib/youzan-category-groups.server": "export const assignSkuToYouzanCategoryGroups = async () => {};",
});

beforeEach(() => {
  state.legacy = null; state.failedTable = null;
  state.rpcs = []; state.finish = []; state.releaseCalls = 0;
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
  const commit = state.rpcs.find((r) => r.name === "handheld_smart_create_commit")!;
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
