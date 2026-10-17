/**
 * POST /api/public/handheld/items/{id}/measurement 已成功 op 回放 HTTP 测试。
 * 真实 handler + 真实输入校验/门店判定/错误码；仅设备/会话、DB 读取与 RPC 用可观测 mock。
 * mock 的 measurement_mutations 语义与 SQL 一致：actor+op 唯一，指纹 = sku/expected_revision/四值。
 * 断言：成功→丢响应→售出/调拨/版本变化→原 body 重试 200 replayed 且 0 新写；
 * 同 op 异 body 409 op_conflict；异 actor 不知结果（走当前校验）；无记录旧请求不伪装成功。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, beforeEach } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

const SKU = "11111111-1111-4111-8111-111111111111";
const LOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type State = {
  sessionUser: string;
  actor: { userId: string; roles: string[]; locationIds: string[] };
  stocks: Array<{ location_id: string; qty: number }>;
  revision: number;
  mutations: Map<string, { fp: string; result: any }>;
  saveCalls: any[];
  actorFails: boolean;
  rpcLocationMismatch: boolean;
};
const state = {} as State;
(globalThis as any).__ms = state;

beforeEach(() => {
  state.sessionUser = "staff";
  state.actor = { userId: "staff", roles: ["store_staff"], locationIds: [LOC_A] };
  state.stocks = [{ location_id: LOC_A, qty: 1 }];
  state.revision = 0;
  state.mutations = new Map();
  state.saveCalls = [];
  state.actorFails = false;
  state.rpcLocationMismatch = false;
});

const fp = (a: any) =>
  JSON.stringify([a.skuId, a.expectedRevision, a.value.height_cm, a.value.width_cm, a.value.depth_cm, a.value.diameter_cm]);

const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => options => options;",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS = {};
    export const json = (body, init) => Response.json(body, init);
    export const ok = (data) => Response.json({ ok: true, data });
    export const authenticateDevice = async () => ({ ok: true, device: { id: "dev" } });
    export const resolveSessionUser = async () => ({ user_id: globalThis.__ms.sessionUser });`,
  "@/integrations/supabase/client.server": "export const supabaseAdmin = new Proxy({}, { get: () => { throw new Error('unexpected direct db'); } });",
  "@/server/measurement-actor.server": "export const loadMeasurementActor = async () => globalThis.__ms.actor; export const tryLoadMeasurementActor = async () => globalThis.__ms.actorFails ? null : globalThis.__ms.actor;",
  "@/server/product-measurement-production.server": `
    const fp = ${fp.toString()};
    export const loadMeasurementSku = async (id) => ({ id, measurement_revision: globalThis.__ms.revision, measured_at: null });
    export const loadSkuStockRows = async () => globalThis.__ms.stocks;
    export const replaySaveProduction = async (a) => {
      const m = globalThis.__ms.mutations.get(a.actorId + "|" + a.clientOpId);
      if (!m) return null;
      if (m.fp !== fp(a) || (a.locationId != null && m.locationId !== a.locationId)) throw new Error("op_conflict");
      return { ...m.result, replayed: true };
    };
    export const saveMeasurementProduction = async (a) => {
      const s = globalThis.__ms;
      s.saveCalls.push(a);
      if (s.rpcLocationMismatch) throw new Error("location_mismatch");
      if (a.expectedRevision !== s.revision) throw new Error("revision_conflict");
      s.revision += 1;
      const result = { revision: s.revision, task_id: null, notified: 0, replayed: false };
      s.mutations.set(a.actorId + "|" + a.clientOpId, { fp: fp(a), locationId: a.locationId, result });
      return result;
    };`,
};
const REAL: Record<string, string> = {
  "@/lib/handheld/errors": path.resolve("src/lib/handheld/errors.ts"),
  "@/server/product-measurement.server": path.resolve("src/server/product-measurement.server.ts"),
};

let handlerPromise: Promise<any> | null = null;
function loadHandler() {
  handlerPromise ??= (async () => {
    const bundle = await build({
      entryPoints: ["src/routes/api/public/handheld/items.$id.measurement.ts"],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      external: ["zod", "node:*"],
      plugins: [
        {
          name: "boundaries",
          setup(b: any) {
            b.onResolve({ filter: /^@\// }, (args: any) =>
              REAL[args.path] ? { path: REAL[args.path] } : { path: args.path, namespace: "stub" },
            );
            b.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => {
              assert.ok(stubs[args.path], `unhandled import ${args.path}`);
              return { contents: stubs[args.path], loader: "js" };
            });
          },
        },
      ],
    });
    const dir = path.resolve("node_modules/.cache/measurement-http-test");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `save-route-${process.pid}.mjs`);
    writeFileSync(file, bundle.outputFiles[0].text);
    const mod = await import(pathToFileURL(file).href);
    return (mod.Route.options ?? mod.Route).server.handlers;
  })();
  return handlerPromise;
}
async function loadGet() {
  return (await loadHandler()).GET;
}

function body(extra: Record<string, unknown> = {}) {
  return {
    location_id: LOC_A,
    expected_revision: 0,
    client_op_id: "op-save-0001",
    measurement: { height_cm: 20, width_cm: 10 },
    ...extra,
  };
}
async function post(payload: unknown) {
  const handler = (await loadHandler()).POST;
  const req = new Request(`http://x/api/public/handheld/items/${SKU}/measurement`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
  const res: Response = await handler({ request: req, params: { id: SKU } });
  return { status: res.status, json: (await res.json()) as any };
}

test("保存成功→丢响应→售出/调拨/他人改版本：原 body 重试 200 replayed，0 新写", async () => {
  const first = await post(body());
  assert.equal(first.status, 200);
  assert.equal(first.json.data.revision, 1);
  // 售出调拨到 B，他人在 B 再保存使版本变为 2
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  state.revision = 2;
  state.saveCalls = [];
  const again = await post(body());
  assert.equal(again.status, 200);
  assert.equal(again.json.data.replayed, true);
  assert.equal(again.json.data.revision, 1);
  assert.equal(state.saveCalls.length, 0, "no new write");
  assert.equal(state.revision, 2, "revision unchanged");
});

test("同 op 异 body：409 op_conflict，0 新写", async () => {
  assert.equal((await post(body())).status, 200);
  state.saveCalls = [];
  const r = await post(body({ measurement: { height_cm: 21, width_cm: 10 } }));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "op_conflict");
  assert.equal(state.saveCalls.length, 0);
});

test("异 actor 重放他人 op：不知原结果，按当前校验（A 已无货）拒绝", async () => {
  assert.equal((await post(body())).status, 200);
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  state.sessionUser = "other";
  state.actor = { userId: "other", roles: ["store_staff"], locationIds: [LOC_A] };
  state.saveCalls = [];
  const r = await post(body());
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "unauthorized_role");
  assert.equal(r.json.data, undefined);
  assert.equal(state.saveCalls.length, 0);
});

test("无成功记录的旧请求：调拨后不伪装成功（被当前库存校验拒绝）", async () => {
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  const r = await post(body({ client_op_id: "op-never-0001" }));
  // 业务拒绝必须 403（Android 对 401 会刷新后登出）
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "unauthorized_role");
  assert.equal(state.saveCalls.length, 0);
});

test("同 op 异 location：409 op_conflict，0 新写（回放带原 location）", async () => {
  state.stocks = [{ location_id: LOC_A, qty: 1 }, { location_id: LOC_B, qty: 1 }];
  state.actor = { userId: "staff", roles: ["store_staff"], locationIds: [LOC_A, LOC_B] };
  assert.equal((await post(body())).status, 200);
  state.saveCalls = [];
  const r = await post(body({ location_id: LOC_B }));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "op_conflict");
  assert.equal(state.saveCalls.length, 0);
});

test("尺寸 0.001 取整为 0：受控 400 invalid_body，不进 DB", async () => {
  const r = await post(body({ client_op_id: "op-tiny-0001", measurement: { height_cm: 0.001 } }));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "invalid_body");
  assert.equal(state.saveCalls.length, 0);
});

test("员工权限读取失败：受控 500 internal_error，不当作无权限、不写", async () => {
  state.actorFails = true;
  const r = await post(body({ client_op_id: "op-actor-0001" }));
  assert.equal(r.status, 500);
  assert.equal(r.json.code, "internal_error");
  assert.equal(state.saveCalls.length, 0);
});

test("无货/跨店业务拒绝统一 403 unauthorized_role（非 401）；RPC 锁内无货也 403", async () => {
  // 预检：A 无货
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  let r = await post(body({ client_op_id: "op-403-00001" }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "unauthorized_role");
  // 跨店
  state.stocks = [{ location_id: LOC_B, qty: 1 }];
  r = await post(body({ client_op_id: "op-403-00002", location_id: LOC_B }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "unauthorized_role");
  // 预检通过但 RPC 锁内发现已调走
  state.stocks = [{ location_id: LOC_A, qty: 1 }];
  state.rpcLocationMismatch = true;
  r = await post(body({ client_op_id: "op-403-00003" }));
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "unauthorized_role");
});

test("已成功原请求在无货后重试：仍先回放 200，而非 403", async () => {
  assert.equal((await post(body())).status, 200);
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  const r = await post(body());
  assert.equal(r.status, 200);
  assert.equal(r.json.data.replayed, true);
});

test("GET 跨店：403 unauthorized_role（非 401）", async () => {
  const handler = await loadGet();
  state.actor = { userId: "staff", roles: ["store_staff"], locationIds: [LOC_B] };
  const res: Response = await handler({
    request: new Request(`http://x/api/public/handheld/items/${SKU}/measurement?location_id=${LOC_A}`),
    params: { id: SKU },
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as any).code, "unauthorized_role");
});
