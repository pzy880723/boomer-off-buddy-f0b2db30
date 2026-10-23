import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = { device: true, session: true, catError: null, cats: [], facets: [], touched: false };
(globalThis as any).__taxo = state;
const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute=()=>o=>o;",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS={};export const ok=d=>Response.json({ok:true,data:d});export const err=(e,status,x)=>Response.json({ok:false,error:e,...x},{status});export const authenticateDevice=async()=>globalThis.__taxo.device?{ok:true,device:{id:'d'}}:{ok:false,response:new Response(null,{status:401})};export const resolveSessionUser=async()=>globalThis.__taxo.session?{user_id:'u'}:null;`,
  "@/lib/attribute-labels": "export const labelFacets=r=>r;",
  // 模拟 PostgREST：按 eq 条件过滤，证明路由要求 kind=category 且 is_active=true
  "@/integrations/supabase/client.server": `export const supabaseAdmin={from(t){const s=globalThis.__taxo;s.touched=true;(s.tables=s.tables||[]).push(t);const f=[];const q={select(){return q},eq(k,v){f.push([k,v]);return q},order(){return q},then(res,rej){const rows=(t==='inv_categories'?s.cats:s.facets).filter(r=>f.every(([k,v])=>r[k]===v));const out=t==='inv_categories'&&s.catError?{data:null,error:{message:s.catError}}:{data:rows,error:null};return Promise.resolve(out).then(res,rej)}};return q}};`,
};
let handler: any;
async function get() {
  if (!handler) {
    const out = await build({ entryPoints: ["src/routes/api/public/handheld/product-taxonomy.ts"], bundle: true, write: false, platform: "node", format: "esm",
      plugins: [{ name: "stubs", setup(b: any) {
        b.onResolve({ filter: /^@/ }, (a: any) => (stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path] }));
      } }] });
    const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
    handler = m.Route.server.handlers.GET;
  }
  state.touched = false;
  return handler({ request: new Request("http://local/api/public/handheld/product-taxonomy") });
}
const cat = (id: string, code: string, name: string, parent_id: string | null, is_active = true, kind = "category") => ({ id, code, name, parent_id, is_active, kind, sort_order: 0 });

test("missing device or employee session → 401 before any query", async () => {
  state.device = false; state.session = true;
  assert.equal((await get()).status, 401); assert.equal(state.touched, false);
  state.device = true; state.session = false;
  assert.equal((await get()).status, 401); assert.equal(state.touched, false);
});

test("returns zero-stock active leaf with Chinese parent; inactive excluded", async () => {
  state.device = true; state.session = true; state.catError = null;
  state.cats = [
    cat("p", "toy_model", "玩具模型", null),
    cat("c1", "toy_board_card", "桌游/卡牌", "p"),
    cat("c2", "toy_old", "停用分类", "p", false),
    cat("x", "dead_root", "停用根", null, false),
    cat("c3", "dead_leaf", "孤儿", "x"),
  ];
  state.facets = [{ code: "f1", name: "昭和", dimension: "era", is_active: true }, { code: "f2", name: "旧", dimension: "era", is_active: false }];
  const r = await get();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.data.primary_categories.length, 1);
  assert.deepEqual(j.data.primary_categories[0].children, [
    { code: "toy_board_card", name: "桌游/卡牌", parent_code: "toy_model", parent_name: "玩具模型" },
  ]);
  assert.deepEqual(j.data.facets.map((f: any) => f.code), ["f1"]);
});

test("DB error never returns empty success", async () => {
  state.catError = "boom";
  const r = await get();
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.ok, false); assert.equal(j.code, "taxonomy_unavailable");
  state.catError = null;
});

test("valid device but missing employee session → 401 session_required, no query", async () => {
  state.device = true; state.session = false;
  const r = await get();
  assert.equal(r.status, 401); assert.equal((await r.json()).code, "session_required"); assert.equal(state.touched, false);
  state.session = true;
});

test("explicitly inactive leaf is excluded even with an active parent", async () => {
  state.cats = [cat("p", "toy_model", "玩具模型", null), cat("on", "toy_board_card", "桌游/卡牌", "p"), cat("off", "toy_retired", "已停用", "p", false)];
  state.facets = [];
  const j = await (await get()).json();
  assert.deepEqual(j.data.primary_categories[0].children.map((c: any) => c.code), ["toy_board_card"]);
});

test("all 89 active leaves returned; no stock/listing table is read", async () => {
  const roots = Array.from({ length: 9 }, (_, i) => cat(`r${i}`, `root_${i}`, `一级${i}`, null));
  const leaves = Array.from({ length: 89 }, (_, i) => cat(`l${i}`, `leaf_${i}`, `末级${i}`, `r${i % 9}`));
  state.cats = [...roots, ...leaves]; state.facets = []; state.tables = [];
  const j = await (await get()).json();
  const n = j.data.primary_categories.reduce((a: number, p: any) => a + p.children.length, 0);
  assert.equal(n, 89);
  assert.deepEqual([...new Set(state.tables)].sort(), ["inv_categories", "inv_facets"]);
});
