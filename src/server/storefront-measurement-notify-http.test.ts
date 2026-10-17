/**
 * 真实 handler 回归（esbuild 打包实际路由，仅替换鉴权/DB 边界）：
 * 1) 顾客通知返回 kind + product_id（小程序 measurement_completed 跳转依赖），且仍按当前顾客过滤；
 * 2) 测量申请：not_found 受控 404、无现货受控中文 unavailable、内部错误通用中文 500 不泄露原始信息。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

type S = { filters: Array<[string, unknown]>; select: string; rows: unknown[]; requestImpl: () => Promise<unknown> };
const state: S = { filters: [], select: "", rows: [], requestImpl: async () => ({}) };
(globalThis as any).__sn = state;

const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => (o) => o;",
  "@/server/storefront-auth.server": `
    export const STOREFRONT_CORS = {};
    export const storefrontJson = (body, init = {}) => Response.json(body, init);
    export const storefrontError = (message, status = 400) => Response.json({ ok: false, error: message }, { status });
    export const authenticateStorefrontCustomer = async () => ({ ok: true, customer: { id: "cust-1" } });`,
  "@/integrations/supabase/client.server": `
    const st = () => globalThis.__sn;
    const q = {
      select(c) { st().select = c; return q; },
      eq(k, v) { st().filters.push([k, v]); return q; },
      order() { return q; },
      limit() { return Promise.resolve({ data: st().rows, error: null }); },
    };
    export const supabaseAdmin = { from: () => q };`,
  "@/server/product-measurement-production.server": `
    export const requestMeasurementProduction = () => globalThis.__sn.requestImpl();`,
};

async function load(entry: string, method: "GET" | "POST") {
  const out = await build({
    entryPoints: [path.resolve(entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "stubs",
        setup(b: any) {
          b.onResolve({ filter: /^@/ }, (a: any) => ({ path: a.path, namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => {
            assert.ok(stubs[a.path], `unhandled import ${a.path}`);
            return { contents: stubs[a.path], loader: "js" };
          });
        },
      },
    ],
  });
  const url = "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64");
  const mod = await import(url);
  return (mod.Route.server ?? mod.Route.options.server).handlers[method];
}

test("通知列表：返回 kind 与 product_id，且仍只查当前顾客", async () => {
  const GET = await load("src/routes/api/public/storefront/notifications.ts", "GET");
  state.filters = [];
  state.rows = [
    { id: "n1", kind: "measurement_completed", title: "商品尺寸已测量", body: "b", shortage_id: null, order_id: null, product_id: "listing-9", read_at: null, created_at: "2026-10-17T00:00:00Z" },
  ];
  const res = await GET({ request: new Request("http://x/api/public/storefront/notifications") });
  const json = await res.json();
  assert.match(state.select, /\bkind\b/);
  assert.match(state.select, /\bproduct_id\b/);
  assert.deepEqual(state.filters, [["customer_id", "cust-1"]]);
  assert.equal(json.data.items[0].kind, "measurement_completed");
  assert.equal(json.data.items[0].product_id, "listing-9");
  assert.equal(json.data.unread_count, 1);
});

test("测量申请：not_found → 受控 404", async () => {
  const POST = await load("src/routes/api/public/storefront/products.$id.measurement-requests.ts", "POST");
  state.requestImpl = async () => { throw new Error("not_found"); };
  const res = await POST({ params: { id: "l1" }, request: new Request("http://x", { method: "POST" }) });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
});

test("测量申请：无现货 → 200 unavailable 中文提示，原样透传受控 message", async () => {
  const POST = await load("src/routes/api/public/storefront/products.$id.measurement-requests.ts", "POST");
  state.requestImpl = async () => ({ status: "unavailable", task_id: null, requested_at: null, measurement: null, message: "该商品暂无门店现货，暂时无法安排测量，请联系门店咨询" });
  const res = await POST({ params: { id: "l1" }, request: new Request("http://x", { method: "POST" }) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.status, "unavailable");
  assert.equal(json.data.task_id, null);
  assert.match(json.data.message, /联系门店/);
});

test("测量申请：内部错误 → 通用中文 500，不泄露原始错误", async () => {
  const POST = await load("src/routes/api/public/storefront/products.$id.measurement-requests.ts", "POST");
  const secret = 'relation "inv_skus" column v_sku.location_id does not exist';
  state.requestImpl = async () => { throw new Error(secret); };
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await POST({ params: { id: "l1" }, request: new Request("http://x", { method: "POST" }) });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.ok(!text.includes("inv_skus") && !text.includes("location_id"), "no internal message");
    assert.match(JSON.parse(text).error, /服务暂时不可用/);
  } finally {
    console.error = orig;
  }
});
