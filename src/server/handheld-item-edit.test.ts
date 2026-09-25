import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

type Rpc = { name: string; args: Record<string, any> };
const state: {
  rpcs: Rpc[];
  session: { user_id: string } | null;
  rpc: (name: string) => { data?: unknown; error?: { message: string; details?: string } | null };
  finish: string[];
} = {} as never;
(globalThis as any).__ie = { state };

async function load(entry: string, stubs: Record<string, string>) {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "stubs", setup(b: any) {
      b.onResolve({ filter: /^@\// }, (a: any) =>
        stubs[a.path] ? { path: a.path, namespace: "stub" }
          : { path: resolve(a.path.replace(/^@\//, "src/") + ".ts") });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path], loader: "js" }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

const admin = `export const supabaseAdmin = {
  rpc: async (name, args) => { const s = globalThis.__ie.state; s.rpcs.push({ name, args });
    if (name === "handheld_item_sync_outbox_claim") return { data: [{ id: "o1", sku_id: "s", shop_id: "sh", claim_token: "t", attempts: 1 }], error: null };
    if (name === "handheld_item_sync_outbox_finish") { s.finish.push(args.p_ok + ":" + args.p_cancel + ":" + args.p_error); return { data: args.p_cancel ? "cancelled" : args.p_ok ? "done" : "failed", error: null }; }
    return s.rpc(name); },
  from: () => ({}) };`;
const auth = `export const resolveSessionUser = async () => globalThis.__ie.state.session;
  export const ok = d => Response.json({ ok: true, data: d });
  export const err = (m, s, x = {}) => Response.json({ ok: false, error: m, ...x }, { status: s });`;

const edit = await load("src/server/handheld-item-edit.server.ts", {
  "@/integrations/supabase/client.server": admin,
  "@/server/handheld-auth.server": auth,
});
const worker = await load("src/server/handheld-item-sync-outbox.server.ts", {
  "@/integrations/supabase/client.server": admin,
  "@/lib/youzan-offline-products.functions": "export const syncSkuInfoToYouzanBranchCore = async () => { throw new Error('no network in tests'); };",
});

const LOC = "2df58305-57c1-4792-9920-3c3aa49890bc";
const SKU = "e5735c1b-b9f5-4b9f-bf6e-e3ee4c4e9b54";
const req = (body: unknown) => new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body) });
const patchBody = (extra: Record<string, unknown> = {}) => ({
  location_id: LOC, client_op_id: "op-12345678", expected_updated_at: "2026-09-24T07:13:02.096Z", ...extra,
});

beforeEach(() => {
  state.rpcs = []; state.finish = []; state.session = { user_id: "u1" };
  state.rpc = () => ({ data: { sku_id: SKU, updated_at: "t2", changed_fields: ["price_tier"], replayed: false, youzan_sync_queued: 1 }, error: null });
});

test("PATCH without employee session is 401", async () => {
  state.session = null;
  const res = await edit.handleItemPatch(req(patchBody({ name: "x" })), "dev", SKU);
  assert.equal(res.status, 401);
  assert.equal(state.rpcs.length, 0);
});

test("PATCH maps description/condition_grade and sends yuan price", async () => {
  const res = await edit.handleItemPatch(req(patchBody({ price_tier: 12.3, description: "d", condition_grade: "A" })), "dev", SKU);
  assert.equal(res.status, 200);
  const args = state.rpcs[0].args;
  assert.deepEqual(args.p_patch, { price_tier: 12.3, notes: "d", grade: "A" });
  assert.equal(args.p_user_id, "u1");
  assert.equal((await res.json()).data.youzan_sync_queued, 1);
});

for (const [label, extra] of [
  ["three decimals", { price_tier: 1.234 }], ["zero price", { price_tier: 0 }],
  ["string price", { price_tier: "10" }], ["barcode", { barcode: "123" }],
  ["stock", { stock_qty: 3 }], ["empty patch", {}],
] as const) {
  test(`PATCH rejects ${label} with 422 before touching the database`, async () => {
    const res = await edit.handleItemPatch(req(patchBody(extra as never)), "dev", SKU);
    assert.equal(res.status, 422);
    assert.equal(state.rpcs.length, 0);
  });
}

test("fingerprint is stable and payload-sensitive", () => {
  const a = edit.itemOpFingerprint("update", SKU, { patch: { name: "a", notes: null } });
  assert.equal(a, edit.itemOpFingerprint("update", SKU, { patch: { notes: null, name: "a" } }));
  assert.notEqual(a, edit.itemOpFingerprint("update", SKU, { patch: { name: "b", notes: null } }));
});

test("PATCH accepts ordered image-only edits and deletion of all images", async () => {
  for (const paths of [["sku-listing/2026-09-25/device/b.jpg", "sku-raw/2026-09-25/device/a.jpg"], []]) {
    state.rpcs = [];
    const res = await edit.handleItemPatch(req(patchBody({ image_paths: paths })), "dev", SKU);
    assert.equal(res.status, 200);
    assert.deepEqual(state.rpcs[0].args.p_patch, { image_paths: paths });
  }
});

for (const paths of [null, ["sku-raw/a.jpg", "sku-raw/a.jpg"], ["sku-raw/../a.jpg"],
  ["sku-raw/a.jpg?token=secret"], ["other/a.jpg"], ["https://example.com/a.jpg?token=secret"],
  Array.from({ length: 21 }, (_, i) => `sku-raw/${i}.jpg`)]) {
  test(`PATCH rejects invalid image references ${JSON.stringify(paths)}`, async () => {
    const res = await edit.handleItemPatch(req(patchBody({ image_paths: paths })), "dev", SKU);
    assert.equal(res.status, 422);
    assert.equal(state.rpcs.length, 0);
  });
}

test("image ordering participates in idempotency fingerprint", () => {
  const paths = ["sku-raw/a.jpg", "sku-raw/b.jpg"];
  assert.notEqual(edit.itemOpFingerprint("update", SKU, { image_paths: paths }),
    edit.itemOpFingerprint("update", SKU, { image_paths: [...paths].reverse() }));
});

for (const [code, status] of [
  ["location_forbidden", 403], ["edit_forbidden", 403], ["standard_readonly", 403],
  ["version_conflict", 409], ["client_op_id_conflict", 409], ["not_found", 404],
] as const) {
  test(`PATCH maps ${code} to ${status}`, async () => {
    state.rpc = () => ({ error: { message: code, details: "detail" } });
    const res = await edit.handleItemPatch(req(patchBody({ name: "x" })), "dev", SKU);
    assert.equal(res.status, status);
    assert.equal((await res.json()).code, code);
  });
}

test("PATCH replay returns original result", async () => {
  state.rpc = () => ({ data: { sku_id: SKU, updated_at: "t2", changed_fields: ["name"], replayed: true, youzan_sync_queued: 0 }, error: null });
  const res = await edit.handleItemPatch(req(patchBody({ name: "x" })), "dev", SKU);
  assert.equal((await res.json()).data.replayed, true);
});

test("DELETE requires confirm:true", async () => {
  const res = await edit.handleItemDelete(req({ location_id: LOC, client_op_id: "op-12345678" }), "dev", SKU);
  assert.equal(res.status, 422);
  assert.equal(state.rpcs.length, 0);
});

test("DELETE blocked by history returns 409 with Chinese reason", async () => {
  state.rpc = () => ({ error: { message: "delete_blocked", details: "商品已有库存流水，请归档而不是删除" } });
  const res = await edit.handleItemDelete(req({ location_id: LOC, client_op_id: "op-12345678", confirm: true }), "dev", SKU);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "delete_blocked");
  assert.match(body.reason, /库存流水/);
});

test("DELETE by non-HQ is 403 and unknown DB error is 500", async () => {
  state.rpc = () => ({ error: { message: "delete_forbidden", details: "仅总部" } });
  let res = await edit.handleItemDelete(req({ location_id: LOC, client_op_id: "op-12345678", confirm: true }), "dev", SKU);
  assert.equal(res.status, 403);
  state.rpc = () => ({ error: { message: "connection reset" } });
  res = await edit.handleItemDelete(req({ location_id: LOC, client_op_id: "op-12345678", confirm: true }), "dev", SKU);
  assert.equal(res.status, 500);
});

test("worker: Youzan failure is retried (failed), not cancelled", async () => {
  const out = await worker.runHandheldItemSyncWorker(1, { sync: async () => { throw new Error("proxy timeout"); } });
  assert.deepEqual(state.finish, ["false:false:proxy timeout"]);
  assert.equal(out.outcomes[0].status, "failed");
});

test("worker: database read failure is retried, not cancelled", async () => {
  await worker.runHandheldItemSyncWorker(1, { sync: async () => { throw new Error("database unavailable"); } });
  assert.deepEqual(state.finish, ["false:false:database unavailable"]);
});

test("worker: archived/unpublished targets are closed without republishing", async () => {
  await worker.runHandheldItemSyncWorker(1, { sync: async () => ({ skipped: "listing_not_published", price_synced: false, name_pending: false }) });
  assert.deepEqual(state.finish, ["false:true:listing_not_published"]);
});

test("worker: name change is recorded as awaiting API confirmation", async () => {
  await worker.runHandheldItemSyncWorker(1, { sync: async () => ({ price_synced: true, name_pending: true }) });
  assert.deepEqual(state.finish, ["false:true:name_sync_api_unconfirmed"]);
});

test("worker: price synced completes", async () => {
  await worker.runHandheldItemSyncWorker(1, { sync: async () => ({ price_synced: true, name_pending: false }) });
  assert.deepEqual(state.finish, ["true:false:null"]);
});
