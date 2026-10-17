/**
 * POST /api/public/handheld/items/{id}/measurement-image 认证后 HTTP 行为测试。
 * 真实 handler + 真实 PNG 校验（sharp）+ 真实错误码表；仅设备/会话、DB 读取、
 * 存储上传、登记 RPC 用可观测 mock。断言：必须先过 PNG 校验才上传/登记；
 * 登记返回冲突不得回 ready；错误不外泄存储/DB 原始信息；请求体有上限。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, beforeEach } from "node:test";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

const SKU = "11111111-1111-4111-8111-111111111111";
const LOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Sku = {
  id: string;
  measurement_height_cm: number | null;
  measurement_width_cm: number | null;
  measurement_diameter_cm: number | null;
  measured_at: string | null;
  measurement_revision: number;
};
type State = {
  sku: Sku | null;
  /** 真实 inv_stocks 形态：SKU 无门店字段，门店只看库存行 */
  stocks: Array<{ location_id: string; qty: number }>;
  actor: { userId: string; roles: string[]; locationIds: string[] };
  uploads: string[];
  uploadFail: boolean;
  registerCalls: any[];
  register: (args: any) => any;
  /** 已完成 mutation（模拟 measurement_mutations：actor+op 唯一，指纹 sku/revision/location/hash） */
  mutations: Map<string, { fp: string; result: any; asset: any }>;
  sessionUser: string;
};
const state: State = {} as State;
(globalThis as any).__mi = state;

beforeEach(() => {
  state.sku = {
    id: SKU,
    measurement_height_cm: 20,
    measurement_width_cm: 10,
    measurement_diameter_cm: null,
    measured_at: "2026-10-17T00:00:00Z",
    measurement_revision: 3,
  };
  state.stocks = [{ location_id: LOC_A, qty: 1 }];
  state.actor = { userId: "staff", roles: ["store_staff"], locationIds: [LOC_A] };
  state.uploads = [];
  state.uploadFail = false;
  state.registerCalls = [];
  state.mutations = new Map();
  state.sessionUser = "staff";
  state.register = (a) => ({
    status: "ready",
    revision: a.revision,
    location_id: a.locationId,
    cutout_preview_path: a.previewPath,
    width_cm: a.widthCm,
    height_cm: a.heightCm,
    replayed: false,
  });
});

const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => options => options;",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS = {};
    export const json = (body, init) => Response.json(body, init);
    export const ok = (data) => Response.json({ ok: true, data });
    export const authenticateDevice = async () => ({ ok: true, device: { id: "dev" } });
    export const resolveSessionUser = async () => ({ user_id: globalThis.__mi.sessionUser });`,
  "@/server/product-measurement-production.server": `
    export const loadMeasurementSku = async () => globalThis.__mi.sku;
    export const loadSkuStockRows = async () => globalThis.__mi.stocks;
    export const uploadMeasurementDerivativeProduction = async (p) => {
      if (globalThis.__mi.uploadFail) throw new Error("storage_failed");
      globalThis.__mi.uploads.push(p);
    };
    export const registerMeasurementAssetProduction = async (a) => {
      globalThis.__mi.registerCalls.push(a);
      const r = globalThis.__mi.register(a);
      globalThis.__mi.mutations.set(a.actorId + "|" + a.clientOpId, {
        fp: [a.skuId, a.revision, a.locationId, a.contentHash].join("|"), result: r,
        asset: { bbox: a.bbox, front_width_px: a.frontWidthPx, front_height_px: a.frontHeightPx, px_per_cm: a.pxPerCm } });
      return r;
    };
    export const replayAssetProduction = async (a) => {
      const m = globalThis.__mi.mutations.get(a.actorId + "|" + a.clientOpId);
      if (!m) return null;
      if (m.fp !== [a.skuId, a.revision, a.locationId, a.contentHash].join("|")) throw new Error("op_conflict");
      return { ...m.result, ...m.asset, replayed: true };
    };`,
  "@/server/measurement-actor.server": "export const loadMeasurementActor = async () => globalThis.__mi.actor;",
};
const REAL: Record<string, string> = {
  "@/server/measurement-image.server": path.resolve("src/server/measurement-image.server.ts"),
  "@/lib/handheld/errors": path.resolve("src/lib/handheld/errors.ts"),
  "@/server/product-measurement.server": path.resolve("src/server/product-measurement.server.ts"),
};

let handlerPromise: Promise<any> | null = null;
function loadHandler() {
  handlerPromise ??= (async () => {
    const bundle = await build({
      entryPoints: ["src/routes/api/public/handheld/items.$id.measurement-image.ts"],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      external: ["sharp", "zod", "node:*"],
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
    const file = path.join(dir, `route-${process.pid}.mjs`);
    writeFileSync(file, bundle.outputFiles[0].text);
    const mod = await import(pathToFileURL(file).href);
    return (mod.Route.options ?? mod.Route).server.handlers.POST;
  })();
  return handlerPromise;
}

async function transparentPng(w: number, h: number): Promise<Buffer> {
  const rect = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rect, left: 50, top: 50 }])
    .png()
    .toBuffer();
}
async function opaquePng(): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
}

function body(png: Buffer, extra: Record<string, unknown> = {}) {
  return {
    location_id: LOC_A,
    revision: 3,
    client_op_id: "op-image-0001",
    image_png_base64: png.toString("base64"),
    verified_front: true,
    ...extra,
  };
}
async function post(payload: unknown, init: RequestInit = {}) {
  const handler = await loadHandler();
  const req = new Request("http://x/api/public/handheld/items/" + SKU + "/measurement-image", {
    method: "POST",
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    ...init,
  });
  const res: Response = await handler({ request: req, params: { id: SKU } });
  return { status: res.status, json: (await res.json()) as any };
}
function assertNoWrites() {
  assert.equal(state.uploads.length, 0, "no upload");
  assert.equal(state.registerCalls.length, 0, "no register");
}

test("合规透明 PNG：先校验→上传 640/1280→登记 RPC，HTTP 用登记结果回 ready", async () => {
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 200);
  assert.equal(state.uploads.length, 2);
  assert.equal(state.registerCalls.length, 1);
  const a = state.registerCalls[0];
  assert.equal(a.revision, 3);
  assert.equal(a.locationId, LOC_A);
  assert.equal(a.heightCm, 20);
  assert.equal(a.widthCm, 10);
  assert.match(a.previewPath, new RegExp(`^sku-listing/measurements/${SKU}/3-[0-9a-f]{16}-640\\.png$`));
  assert.equal(r.json.data.diagram.status, "ready");
  assert.equal(r.json.data.diagram.revision, 3);
  assert.match(r.json.data.diagram.cutout_preview_url, /^\/api\/public\/media\/measurement\/measurements\//);
});

test("跨店 actor：403，不上传不登记", async () => {
  state.actor = { userId: "staff", roles: ["store_staff"], locationIds: [LOC_B] };
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 403);
  assertNoWrites();
});

test("SKU 已调店（A0B1）：总部用旧店 A 上传也 403，不上传不登记", async () => {
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  state.actor = { userId: "hq", roles: ["super_admin"], locationIds: [] };
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 403);
  assertNoWrites();
});

test("A0B1：新店 B 员工上传通过并以 B 登记", async () => {
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  state.actor = { userId: "staff", roles: ["store_staff"], locationIds: [LOC_B] };
  const r = await post(body(await transparentPng(100, 200), { location_id: LOC_B }));
  assert.equal(r.status, 200);
  assert.equal(state.registerCalls[0].locationId, LOC_B);
});

test("SKU 在该店无任何库存行：403", async () => {
  state.stocks = [];
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 403);
  assertNoWrites();
});

test("版本已变化（预检）：409 revision_conflict，不上传不登记", async () => {
  state.sku!.measurement_revision = 4;
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "revision_conflict");
  assertNoWrites();
});

test("不透明 PNG / 比例不符：422 且不上传不登记", async () => {
  let r = await post(body(await opaquePng()));
  assert.equal(r.status, 422);
  assert.equal(r.json.reason, "no_alpha");
  r = await post(body(await transparentPng(100, 120)));
  assert.equal(r.status, 422);
  assert.equal(r.json.reason, "ratio_mismatch");
  assertNoWrites();
});

test("上传期间被改尺寸：登记返回 revision_conflict → 409 且不回 ready", async () => {
  state.register = () => {
    throw new Error("revision_conflict");
  };
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "revision_conflict");
  assert.equal(r.json.data, undefined);
});

test("上传期间被调店：登记返回 location_mismatch → 403 且不回 ready", async () => {
  state.register = () => {
    throw new Error("location_mismatch");
  };
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 403);
  assert.equal(r.json.data, undefined);
});

test("同 revision 已有别的图：image_conflict 409；同 op 换图：op_conflict 409", async () => {
  state.register = () => {
    throw new Error("image_conflict");
  };
  let r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "image_conflict");
  state.register = () => {
    throw new Error("op_conflict");
  };
  r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "op_conflict");
});

test("存储失败：500 受控文案不含原始错误、不登记；同 op 重试成功且可回放", async () => {
  state.uploadFail = true;
  const png = await transparentPng(100, 200);
  let r = await post(body(png));
  assert.equal(r.status, 500);
  assert.equal(r.json.code, "internal_error");
  assert.doesNotMatch(r.json.error, /storage_failed/);
  assert.equal(state.registerCalls.length, 0);

  state.uploadFail = false;
  state.register = (a) => ({
    status: "ready", revision: a.revision, location_id: a.locationId,
    cutout_preview_path: a.previewPath, width_cm: a.widthCm, height_cm: a.heightCm, replayed: true,
  });
  r = await post(body(png));
  assert.equal(r.status, 200);
  assert.equal(r.json.data.replayed, true);
});

test("登记内部错误：500 受控 code，不外泄 DB 原始信息", async () => {
  state.register = () => {
    throw new Error("register_failed");
  };
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 500);
  assert.equal(r.json.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(r.json), /register_failed|relation|column|duplicate/);
});

test("请求体 >7MB：413，不读 DB 不上传", async () => {
  state.sku = null; // 若误读 DB 会得到 404 而非 413
  const big = "x".repeat(7 * 1024 * 1024 + 1);
  let r = await post(big);
  assert.equal(r.status, 413);
  r = await post("{}", { headers: { "content-length": String(8 * 1024 * 1024) } });
  assert.equal(r.status, 413);
  assertNoWrites();
});

test("非严格 base64：400，不上传不登记", async () => {
  const png = await transparentPng(100, 200);
  const b64 = png.toString("base64");
  for (const bad of [b64.slice(0, 20) + "\n" + b64.slice(20), b64.replace(/\+/g, "-") + (b64.includes("+") ? "" : "-"), b64.slice(0, -1)]) {
    const r = await post(body(png, { image_png_base64: bad }));
    assert.equal(r.status, 400, `rejected: ${bad.slice(0, 10)}`);
  }
  assertNoWrites();
});


test("已成功上传→丢响应→售出/调拨/版本变化：原 body 重试 200 replayed，0 新上传/登记", async () => {
  const png = await transparentPng(100, 200);
  const first = await post(body(png));
  assert.equal(first.status, 200);
  state.uploads = [];
  state.registerCalls = [];
  // 售出调拨到 B，且实测版本被他人改为 4、尺寸改变
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  state.sku = { ...state.sku!, measurement_revision: 4, measurement_height_cm: 30 };
  const again = await post(body(png));
  assert.equal(again.status, 200);
  assert.equal(again.json.data.replayed, true);
  assert.equal(again.json.data.diagram.revision, 3);
  assert.equal(again.json.data.diagram.cutout_preview_url, first.json.data.diagram.cutout_preview_url);
  assert.equal(again.json.data.diagram.cutout_1280_url, first.json.data.diagram.cutout_1280_url);
  assert.deepEqual(again.json.data.diagram.bbox, first.json.data.diagram.bbox);
  assertNoWrites();
});

test("同 op 异图：409 op_conflict，不上传不登记", async () => {
  assert.equal((await post(body(await transparentPng(100, 200)))).status, 200);
  state.uploads = [];
  state.registerCalls = [];
  const r = await post(body(await transparentPng(101, 202)));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "op_conflict");
  assertNoWrites();
});

test("异 actor 用他人 op 重放：不知原结果，走当前校验（调店后 403）", async () => {
  const png = await transparentPng(100, 200);
  assert.equal((await post(body(png))).status, 200);
  state.uploads = [];
  state.registerCalls = [];
  state.stocks = [{ location_id: LOC_A, qty: 0 }, { location_id: LOC_B, qty: 1 }];
  state.sessionUser = "other";
  state.actor = { userId: "other", roles: ["store_staff"], locationIds: [LOC_A] };
  const r = await post(body(png));
  assert.equal(r.status, 403);
  assert.equal(r.json.data, undefined);
  assertNoWrites();
});

test("无成功记录的旧请求：版本变化后不能伪装成功（409 revision_conflict）", async () => {
  state.sku = { ...state.sku!, measurement_revision: 4 };
  const r = await post(body(await transparentPng(100, 200)));
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "revision_conflict");
  assertNoWrites();
});
