import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
let tables: Record<string, any[]>;
let writes: any[];
let failure: string | null;
let linkReadError = false;
const db = {
  from(table: string) {
    const filters: ((r: any) => boolean)[] = [];
    let patch: any;
    let single = false;
    const q: any = {
      select: () => q, order: () => q, limit: () => q, lte: () => q,
      eq: (k: string, v: any) => { filters.push(r => r[k] === v); return q; },
      lt: (k: string, v: any) => { filters.push(r => r[k] < v); return q; },
      in: (k: string, vs: any[]) => { filters.push(r => vs.includes(r[k])); return q; },
      update: (p: any) => { patch = p; return q; },
      maybeSingle: () => { single = true; return q; }, single: () => { single = true; return q; },
      then: (yes: any, no: any) => Promise.resolve().then(() => {
        assert.ok(tables[table], `Unexpected table ${table}`);
        if (table === "sku_youzan_links" && !patch && linkReadError) {
          return { data: null, error: { message: "link read unavailable" } };
        }
        const rows = tables[table].filter(r => filters.every(f => f(r)));
        if (patch) rows.forEach(r => Object.assign(r, patch));
        return { data: single ? rows[0] ?? null : rows.map(r => ({...r})), error: null };
      }).then(yes, no),
    };
    return q;
  },
};
(globalThis as any).__archiveSync = {
  db,
  stock: (v: any) => { writes.push({ stock: v.quantity, shop: v.branchShop.id }); if (failure === "stock") throw Error("stock timeout"); },
  api: (v: any) => {
    if (v.method === "youzan.retail.open.spu.query") return {payload:{list:[{spu_id:100,spu_code:"HQ",skus:[{sku_id:101,sku_code:"BAR"}]}]}};
    if (v.method === "youzan.item.itemdetail.get") return {payload:{kdt_id:123,channel:1,item_code:"HQ",channel_item_id:202,skus:[{channel_sku_id:203,sku_barcode:"BAR",price:5990}]}};
    writes.push(v);
    if (failure === "shelf") throw Error("shelf timeout");
    return {payload:{}};
  },
};
const stubs: Record<string, string> = {
  "@tanstack/react-start": "export const createServerFn = () => { const c={middleware:()=>c,inputValidator:()=>c,handler:f=>f}; return c; };",
  "@/integrations/supabase/client.server": "export const supabaseAdmin=globalThis.__archiveSync.db;",
  "@/integrations/supabase/auth-middleware": "export const requireSupabaseAuth={};",
  "./youzan.functions": `export const ensureAccessToken=async()=>"test";
    export const getHqShop=async()=>({id:"hq",role:"hq"});
    export const callYouzanApiVerbose=async v=>globalThis.__archiveSync.api(v);
    export const pushYouzanQuantityUpdate=async v=>globalThis.__archiveSync.stock(v);
    export const explainYouzanError=e=>String(e);
    export const callYouzanMultipartApiVerbose=async()=>{throw Error("unexpected create");};
    export const callYouzanApiWithVersionFallback=async()=>{throw Error("unexpected create");};
    export const runYouzanShopChainProbe=async()=>{throw Error("unexpected create");};`,
};
const bundle = await build({entryPoints:["src/lib/youzan-sync.functions.ts"],bundle:true,write:false,platform:"node",format:"esm",
  plugins:[{name:"boundaries",setup(b:any){
    b.onResolve({filter:/.*/},(a:any)=>stubs[a.path]?{path:a.path,namespace:"stub"}:a.path.startsWith("@/")?{path:resolve(a.path.replace(/^@\//,"src/")+".ts")}:null);
    b.onLoad({filter:/.*/,namespace:"stub"},(a:any)=>({contents:stubs[a.path],loader:"js"}));
  }}]});
const worker=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
beforeEach(()=>{
  writes=[]; failure=null; linkReadError=false;
  tables={
    youzan_stock_sync_queue:[{id:"q",sku_id:"sku",shop_id:"branch",status:"pending",action:"push_is_display",target_is_display:true,target_stock:9999,attempts:0,updated_at:"rev"}],
    inv_skus:[{id:"sku",status:"archived",is_custom_price:false,sku_scope:"standard"}],
    sku_youzan_links:[{id:"l",sku_id:"sku",shop_id:"branch",yz_item_id:200,yz_sku_id:201}, {id:"h",sku_id:"sku",shop_id:"hq",yz_item_id:100,yz_sku_id:101}],
    youzan_shops:[{id:"branch",role:"branch",kdt_id:123}],
  };
});
test("archived standard variant: stale publish job clears only its stock, never hides sibling prices",async()=>{
  const r=await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(r.ok,1);
  assert.deepEqual(writes,[{stock:0,shop:"branch"}]);
  assert.equal(tables.youzan_stock_sync_queue[0].status,"done");
});
test("archived missing link is not recreated or distributed",async()=>{
  tables.sku_youzan_links=[];
  const r=await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(r.ok,1);
  assert.deepEqual(writes,[]);
});
test("archived stock failure remains retryable, never marked done",async()=>{
  failure="stock";
  const r=await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(r.failed,1);
  assert.equal(tables.youzan_stock_sync_queue[0].status,"failed");
});
test("archived custom product clears stock and delists using refreshed branch identity",async()=>{
  tables.inv_skus[0].is_custom_price=true;
  tables.inv_skus[0].sku_scope="custom";
  const r=await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(r.ok,1);
  assert.equal(writes[0].stock,0);
  assert.equal(writes[1].method,"youzan.item.update.delisting");
  assert.equal(writes[1].params.item_id,202);
});
test("custom delisting failure retries after stock already reached zero",async()=>{
  tables.inv_skus[0].is_custom_price=true;
  tables.inv_skus[0].sku_scope="custom";
  failure="shelf";
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).failed,1);
  assert.equal(tables.youzan_stock_sync_queue[0].status,"failed");
});
test("minute worker consumes only durable item-delete tasks",async()=>{
  tables.youzan_stock_sync_queue.push({...tables.youzan_stock_sync_queue[0],id:"delete",reason:"handheld_item_deleted"});
  const r=await worker.runArchivedItemStockSyncWorker(3);
  assert.equal(r.processed,1);
  assert.equal(tables.youzan_stock_sync_queue[0].status,"pending");
  assert.equal(tables.youzan_stock_sync_queue[1].status,"done");
});
test("minute worker recovers an abandoned delete job but not a fresh running job",async()=>{
  tables.youzan_stock_sync_queue[0].reason="handheld_item_deleted";
  tables.youzan_stock_sync_queue[0].status="running";
  tables.youzan_stock_sync_queue[0].updated_at="2000-01-01T00:00:00Z";
  tables.youzan_stock_sync_queue.push({...tables.youzan_stock_sync_queue[0],id:"fresh",updated_at:new Date().toISOString()});
  await worker.runArchivedItemStockSyncWorker();
  assert.equal(tables.youzan_stock_sync_queue[0].status,"done");
  assert.equal(tables.youzan_stock_sync_queue[1].status,"running");
});
test("link database failure must not be mistaken for an absent remote listing",async()=>{
  linkReadError=true;
  const r=await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(r.failed,1);
  assert.equal(tables.youzan_stock_sync_queue[0].status,"failed");
  assert.deepEqual(writes,[]);
});
