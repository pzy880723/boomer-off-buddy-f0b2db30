import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

const WH = "5c000000-0000-4000-8000-0000000000aa";
const A = "5c000000-0000-4000-8000-00000000000a";
const B = "5c000000-0000-4000-8000-00000000000b";
const S1 = "shop-a"; const SB = "shop-b"; const SHQ = "shop-hq";
const SKU1 = "11111111-1111-4111-8111-111111111111";
const SKU2 = "22222222-2222-4222-8222-222222222222";

const state: any = {};
(globalThis as any).__sr = state;
function reset() {
  Object.assign(state, {
    session: true, tables: [] as string[], errors: {} as Record<string, boolean>,
    scope: { user_id: "u", device_id: "d", device_location_id: A, location_ids: [A], is_hq: false },
    data: {
      inv_locations: [
        { id: WH, name: "总部仓", kind: "warehouse", shop_id: SHQ },
        { id: A, name: "新天地店", kind: "shop", shop_id: S1 },
        { id: B, name: "温州店", kind: "shop", shop_id: SB },
      ],
      youzan_stock_sync_queue: [
        { id: "q1", sku_id: SKU1, shop_id: S1, location_id: A, target_stock: 1, reason: "offline_product_release", status: "done", attempts: 1, last_error: null, created_at: "3", updated_at: "3" },
        { id: "q2", sku_id: SKU2, shop_id: S1, location_id: B, target_stock: 1, reason: "pos_sale", status: "failed", attempts: 2, last_error: null, created_at: "2", updated_at: "2" },
        { id: "q3", sku_id: SKU2, shop_id: S1, location_id: null, target_stock: 0, reason: "weird_code", status: "pending", attempts: 0, last_error: null, created_at: "1", updated_at: "1" },
        { id: "q4", sku_id: SKU2, shop_id: SB, location_id: B, target_stock: 0, reason: "pos_sale", status: "done", attempts: 1, last_error: null, created_at: "0", updated_at: "0" },
      ],
      inv_skus: [{ id: SKU1, name: "昭和铁皮玩具" }, { id: SKU2, name: "欧洲瓷杯" }],
      youzan_shops: [{ id: S1, shop_name: "BOOMER OFF 新天地" }, { id: SB, shop_name: "BOOMER OFF 温州" }],
    },
  });
}

// 极简 PostgREST 模拟：支持 eq / in / or(location_id.in.(..),and(location_id.is.null,shop_id.in.(..)))
function matchOr(row: any, expr: string): boolean {
  const parts: string[] = []; let depth = 0, cur = "";
  for (const ch of expr) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch; }
  if (cur) parts.push(cur);
  return parts.some((p) => {
    const and = p.match(/^and\((.*)\)$/);
    if (and) return and[1].split(/,(?![^(]*\))/).every((c) => matchOr(row, c));
    const isNull = p.match(/^(\w+)\.is\.null$/); if (isNull) return row[isNull[1]] == null;
    const inn = p.match(/^(\w+)\.in\.\((.*)\)$/); if (inn) return inn[2].split(",").includes(row[inn[1]]);
    throw new Error(`unsupported filter ${p}`);
  });
}
const adminSrc = `export const supabaseAdmin={from(t){const s=globalThis.__sr;s.tables.push(t);const f=[];const q={select(){return q},eq(k,v){f.push(r=>r[k]===v);return q},in(k,v){f.push(r=>v.includes(r[k]));return q},or(e){f.push(r=>globalThis.__srOr(r,e));return q},order(){return q},limit(){return q},then(res,rej){const out=s.errors[t]?{data:null,error:{message:'down'}}:{data:(s.data[t]||[]).filter(r=>f.every(fn=>fn(r))),error:null};return Promise.resolve(out).then(res,rej)}};return q}};`;
(globalThis as any).__srOr = matchOr;

const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute=()=>o=>o;",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS={};export const ok=d=>Response.json({ok:true,data:d});export const err=(e,status,x)=>Response.json({ok:false,error:e,...x},{status});export const authenticateDevice=async()=>({ok:true,device:{id:'d',location_id:globalThis.__sr.scope.device_location_id}});export const resolveSessionUser=async()=>globalThis.__sr.session?{user_id:'u'}:null;`,
  "@/integrations/supabase/client.server": adminSrc,
  "@/server/handheld-notifications.server": "export const resolveNotificationScope=async()=>globalThis.__sr.scope;",
};
let handler: any;
async function get(qs = "") {
  if (!handler) {
    const out = await build({ entryPoints: ["src/routes/api/public/handheld/sync-records.ts"], bundle: true, write: false, platform: "node", format: "esm",
      plugins: [{ name: "stubs", setup(b: any) {
        b.onResolve({ filter: /^@\/server\/handheld-sync-records$/ }, () => ({ path: new URL("./handheld-sync-records.ts", import.meta.url).pathname }));
        b.onResolve({ filter: /^@/ }, (a: any) => (stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path] }));
      } }] });
    handler = (await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`)).Route.server.handlers.GET;
  }
  return handler({ request: new Request(`http://local/api/public/handheld/sync-records${qs}`) });
}
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

test("缺员工会话 → 401，不查任何表", async () => {
  reset(); state.session = false;
  const r = await get();
  assert.equal(r.status, 401); assert.equal((await r.json()).code, "session_required");
  assert.deepEqual(state.tables, []);
});

test("普通员工请求他店 → 403，不查同步队列", async () => {
  reset();
  const r = await get(`?location_id=${B}`);
  assert.equal(r.status, 403);
  assert.ok(!state.tables.includes("youzan_stock_sync_queue"));
});

test("本店：明确 location_id 优先，他店记录即使共享 shop_id 也不漏入；中文名非 UUID", async () => {
  reset();
  const j = await (await get()).json();
  assert.deepEqual(j.data.items.map((i: any) => i.id), ["q1", "q3"]);
  const [a, c] = j.data.items;
  assert.equal(a.sku_name, "昭和铁皮玩具"); assert.equal(a.shop_name, "BOOMER OFF 新天地"); assert.equal(a.location_name, "新天地店");
  assert.equal(a.status_label, "同步任务已结束"); assert.equal(a.reason_label, "商品发布到门店");
  assert.equal(c.location_name, "新天地店"); assert.equal(c.reason_label, "其他同步"); assert.equal(c.status, "pending");
  for (const it of j.data.items) for (const k of ["sku_name", "shop_name", "location_name", "status_label", "reason_label", "next_action"]) assert.doesNotMatch(it[k], UUID_RE);
});

test("总部账号切到门店只看该店", async () => {
  reset(); state.scope = { ...state.scope, device_location_id: WH, location_ids: [WH, A, B], is_hq: true };
  const j = await (await get(`?location_id=${B}`)).json();
  assert.deepEqual(j.data.items.map((i: any) => i.id), ["q2", "q4"]);
  assert.equal(j.data.location_id, B);
});

test("仅总部账号在总部仓位聚合全部授权库位", async () => {
  reset(); state.scope = { ...state.scope, device_location_id: WH, location_ids: [WH, A, B], is_hq: true };
  const j = await (await get()).json();
  assert.deepEqual(j.data.items.map((i: any) => i.id), ["q1", "q2", "q3", "q4"]);
  reset(); state.scope = { ...state.scope, device_location_id: WH, location_ids: [WH], is_hq: false };
  const k = await (await get()).json();
  assert.deepEqual(k.data.items, []);
});

for (const t of ["inv_locations", "youzan_stock_sync_queue", "inv_skus", "youzan_shops"]) {
  test(`${t} 读取失败 → 503，不返回假成功`, async () => {
    reset(); state.errors[t] = true;
    const r = await get();
    assert.equal(r.status, 503);
    const j = await r.json(); assert.equal(j.ok, false); assert.equal(j.code, "sync_records_unavailable");
  });
}
