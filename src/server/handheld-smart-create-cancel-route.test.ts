import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const S: any = {};
(globalThis as any).__scc = S;

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

const { Route } = await load("src/routes/api/public/handheld/items.smart-create.cancel.ts", {
  "@tanstack/react-router": "export const createFileRoute = () => o => o;",
  "zod": `const o = { trim: () => o, min: () => o, max: () => o }; export const z = { object: () => ({}), string: () => o };`,
  "@/server/handheld-auth.server": `const s = globalThis.__scc; export const HANDHELD_CORS = {};
    export const authenticateDevice = async () => s.device ? { ok: true, device: s.device } : { ok: false, response: Response.json({ code: "device_required" }, { status: 401 }) };
    export const resolveSessionUser = async () => s.user ? { user_id: s.user } : null;
    export const userCanAccessLocation = async (u, l) => { s.access.push([u, l]); return s.allowed.includes(l); };
    export const ok = d => Response.json({ ok: true, data: d });
    export const err = (m, st, x = {}) => Response.json({ message: m, ...x }, { status: st });`,
  "@/integrations/supabase/client.server": `export const supabaseAdmin = { rpc: async (n, a) => { globalThis.__scc.rpcs.push({ n, a }); return globalThis.__scc.result(); } };`,
  "@/lib/handheld/schemas": `export const SmartCreateReq = { and: () => ({ safeParse: b => b && typeof b.client_op_id === "string" && b.client_op_id.length >= 8 && b.name ? { success: true, data: b } : { success: false } }) };`,
  "@/server/handheld-smart-create.server": `export const smartCreateRequestFingerprint = (b, loc) => ({ fingerprint: "fp:" + loc + ":" + b.name + ":" + JSON.stringify(b.notice_tags ?? null) });`,
});

beforeEach(() => {
  S.device = { id: "dev1", location_id: "locA" }; S.user = "u1"; S.allowed = ["locA"]; S.access = []; S.rpcs = [];
  S.result = () => ({ data: { state: "cancelled", replayed: false, sku_id: null, response: null }, error: null });
});
const post = (body: any = { client_op_id: "op-000001", name: "屋" }) =>
  Route.server.handlers.POST({ request: new Request("https://x/c", { method: "POST", body: JSON.stringify(body) }) });

test("actor/device/location/fingerprint come from server auth + original body, never client fields", async () => {
  const res = await post({ client_op_id: "op-000001", name: "屋", notice_tags: ["parts_missing"], user_id: "evil", device_id: "evil" });
  assert.equal(res.status, 200);
  assert.deepEqual(S.rpcs[0], { n: "handheld_smart_create_cancel", a: {
    p_device_id: "dev1", p_user_id: "u1", p_client_op_id: "op-000001",
    p_fingerprint: 'fp:locA:屋:["parts_missing"]', p_location_id: "locA" } });
  assert.deepEqual((await res.json()).data, { client_op_id: "op-000001", state: "cancelled", replayed: false, sku_id: null, receipt: null });
});

test("no session / no device / forbidden location / malformed body never reach the DB", async () => {
  S.user = null; assert.equal((await post()).status, 401);
  S.user = "u1"; S.device = null; assert.equal((await post()).status, 401);
  S.device = { id: "dev1", location_id: "locA" };
  const r = await post({ client_op_id: "op-000001", name: "屋", location_id: "locB" });
  assert.equal(r.status, 403); assert.equal((await r.json()).code, "location_forbidden");
  assert.equal((await post({ client_op_id: "short", name: "屋" })).status, 400);
  assert.equal((await post({ client_op_id: "op-000001" })).status, 400);
  assert.equal(S.rpcs.length, 0);
});

test("explicit allowed location_id is used for fingerprint and DB scope", async () => {
  S.allowed = ["locA", "locB"];
  await post({ client_op_id: "op-000001", name: "屋", location_id: "locB" });
  assert.deepEqual(S.access, [["u1", "locB"]]);
  assert.equal(S.rpcs[0].a.p_location_id, "locB");
  assert.equal(S.rpcs[0].a.p_fingerprint, "fp:locB:屋:null");
});

test("P0409 conflict → 409 client_op_id_conflict; other DB error → 503 unknown", async () => {
  S.result = () => ({ data: null, error: { code: "P0409", message: "x" } });
  let r = await post(); assert.equal(r.status, 409); assert.equal((await r.json()).code, "client_op_id_conflict");
  S.result = () => ({ data: null, error: { code: "57014", message: "timeout" } });
  r = await post(); assert.equal(r.status, 503); assert.equal((await r.json()).code, "smart_create_cancel_unknown");
});

test("committed / completed recovery returns the original SKU and receipt", async () => {
  S.result = () => ({ data: { state: "committed", replayed: true, sku_id: "sku1", response: null }, error: null });
  assert.deepEqual((await (await post()).json()).data, { client_op_id: "op-000001", state: "committed", replayed: true, sku_id: "sku1", receipt: null });
  S.result = () => ({ data: { state: "completed", replayed: true, sku_id: "sku1", response: { ok: true, data: { sku_id: "sku1", barcode: "200001" } } }, error: null });
  assert.deepEqual((await (await post()).json()).data.receipt, { ok: true, data: { sku_id: "sku1", barcode: "200001" } });
});

test("malformed or contradictory DB results are 503 unknown, never cancelled", async () => {
  for (const data of [null, {}, { state: "cancelled", replayed: false, sku_id: "sku1" }, { state: "weird", replayed: false, sku_id: null },
    { state: "committed", replayed: true, sku_id: null }, { state: "completed", replayed: true, sku_id: "sku1", response: null },
    { state: "cancelled", sku_id: null }]) {
    S.result = () => ({ data, error: null });
    const r = await post();
    assert.equal(r.status, 503, JSON.stringify(data));
    assert.equal((await r.json()).code, "smart_create_cancel_unknown");
  }
});

test("strict: cancelled needs sku_id===null and response===null; completed needs full matching success receipt", async () => {
  const bad = [
    { state: "cancelled", replayed: false },
    { state: "cancelled", replayed: false, sku_id: null },
    { state: "cancelled", replayed: false, response: null },
    { state: "cancelled", replayed: false, sku_id: null, response: { ok: true } },
    { state: "completed", replayed: true, sku_id: "sku1", response: [] },
    { state: "completed", replayed: true, sku_id: "sku1", response: {} },
    { state: "completed", replayed: true, sku_id: "sku1", response: { ok: false, data: { sku_id: "sku1", barcode: "200001" } } },
    { state: "completed", replayed: true, sku_id: "sku1", response: { ok: true, data: { sku_id: "sku2", barcode: "200001" } } },
    { state: "completed", replayed: true, sku_id: "sku1", response: { ok: true, data: { sku_id: "sku1" } } },
    { state: "completed", replayed: true, sku_id: "sku1", response: { ok: true, data: { sku_id: "sku1", barcode: "" } } },
    { state: "completed", replayed: true, sku_id: "sku1", response: { ok: true, data: [] } },
  ];
  for (const data of bad) {
    S.result = () => ({ data, error: null });
    const r = await post();
    assert.equal(r.status, 503, JSON.stringify(data));
    assert.equal((await r.json()).code, "smart_create_cancel_unknown");
  }
  S.result = () => ({ data: { state: "cancelled", replayed: true, sku_id: null, response: null }, error: null });
  assert.equal((await post()).status, 200);
});
