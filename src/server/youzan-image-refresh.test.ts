import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = { calls: [], images: [] };
(globalThis as any).__imageAdapter = state;
const stubs: Record<string,string> = {
  "@/integrations/supabase/client.server": `export const supabaseAdmin={from:()=>({select(){return this},eq(){return this},then(r){return Promise.resolve({data:[{id:'branch',kdt_id:200},...(globalThis.__imageAdapter.otherShops??[])],error:null}).then(r)},async maybeSingle(){return {data:{id:'branch',kdt_id:200,role:'branch',status:'active'},error:null}}}),rpc:async(name,args)=>{globalThis.__imageAdapter.calls.push({name,args});return {data:[],error:null}}};`,
  "@/lib/youzan.functions": `export const getHqShop=async()=>({id:'hq',kdt_id:100});
    export const ensureAccessToken=async shop=>{if(shop.id!=='hq')throw new Error('branch token forbidden');return 'fake-hq'};
    export const callYouzanApiVerbose=async a=>{const s=globalThis.__imageAdapter;s.calls.push(a);
      if(a.method==='youzan.item.itemdetail.get'){const q=a.params.request;return {payload:{data:{item_code:q.item_code,kdt_id:q.kdt_id,channel:q.channel,display:1,item_id:101,channel_item_id:300,item_barcode:'200001',media:{images:s.images.map(url=>({url}))}}}};}
      if(a.method==='youzan.item.common.update'){s.images=['https://cdn/1','https://cdn/2'];return {payload:{item_id:101}};}
      throw new Error('unexpected mutation '+a.method);
    };`,
  "@/lib/youzan-sync.functions": `export const queryYouzanHqImageMaster=async()=>({spuId:100,spuCode:'ACTUAL-MASTER'});
    export const uploadImageToYouzanMaterialRecord=async(token,url)=>{const n=url.includes('a.png')?1:2;return {imageId:n,imageUrl:'https://cdn/'+n}};`,
  "@/lib/youzan-offline-products.server": `export const isYouzanProductNotFoundError=s=>s.includes('商品不存在');export const parseBranchChannelProduct=(payload,q)=>{const r=payload.data;if(r.item_code!==q.itemCode||r.kdt_id!==q.kdtId)return null;return {itemId:r.channel_item_id,libraryItemId:r.item_id,spuNo:r.item_barcode,skus:[]}};`,
};
const bundle = await build({ entryPoints: ["src/server/youzan-image-refresh.server.ts"], bundle: true, write: false,
  platform: "node", format: "esm", plugins: [{ name: "isolation", setup(b: any) {
    b.onResolve({ filter: /^@\/(integrations|lib\/youzan)/ }, (a: any) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a:any) => ({ contents: stubs[a.path], loader: "js" }));
  } }] });
const { refreshYouzanImages,createYouzanImageRefreshDeps,runYouzanImageRefreshWorker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const snapshot = { sku_id: "sku", shop_id: "branch", kdt_id: 200, hq_shop_id: "hq", hq_spu_id: 100,
  branch_item_id: 300, barcode: "200001", image_paths: ["sku-listing/a.png", "sku-listing/b.png"] };
function fixture() {
  const writes: any[] = [], queries: any[] = [], uploaded: string[] = [];
  let hqImages: string[] = [], branchImages: string[] = [];
  const deps = {
    origin: "https://erp.boomeroff.com",
    assertExclusiveMaster: async () => {},
    readMaster: async () => ({ spuId: 100, itemId: 101, spuCode: "ACTUAL-MASTER", images: hqImages }),
    readBranch: async (code: string) => { queries.push(code); return { itemId: 300, barcode: "200001", images: branchImages }; },
    upload: async (url: string) => { uploaded.push(url); return { imageId: uploaded.length, imageUrl: `https://cdn/${uploaded.length}` }; },
    updateMaster: async (id: number, materials: any[]) => { const urls=materials.map(m=>m.imageUrl); writes.push({ type: "hq", id, urls }); hqImages = urls; branchImages = urls; },
  };
  return { deps, writes, queries, uploaded };
}
test("live master code, exact mapped branch, all images, readback before success", async () => {
  const f = fixture();
  assert.deepEqual(await refreshYouzanImages(snapshot, async () => true, f.deps), { images_synced: 2, images_omitted: 0 });
  assert.deepEqual(f.queries, ["ACTUAL-MASTER", "ACTUAL-MASTER"]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].urls, ["https://cdn/1", "https://cdn/2"]);
  assert.equal(f.writes[0].id, 101,"only the live HQ root id is writable");
});
test("wrong barcode or remapped channel gets zero remote writes", async () => {
  for (const remote of [{ itemId: 300, barcode: "WRONG" }, { itemId: 999, barcode: "200001" }, null]) {
    const f = fixture(); f.deps.readBranch = async () => remote as any;
    await assert.rejects(refreshYouzanImages(snapshot, async () => true, f.deps), /identity/);
    assert.equal(f.writes.length, 0);
  }
});
test("revision changes during upload or between writes leave no stale acknowledged success", async () => {
  for (const allowed of [0, 1]) {
    const f = fixture(); let checks = 0;
    await assert.rejects(refreshYouzanImages(snapshot, async () => checks++ < allowed, f.deps), /superseded/);
    assert.equal(f.writes.length, allowed);
  }
});
test("upload/readback failures propagate; nothing creates, releases, changes quantity or shelves", async () => {
  const f = fixture(); f.deps.upload = async () => { throw new Error("materials unavailable"); };
  await assert.rejects(refreshYouzanImages(snapshot, async () => true, f.deps), /materials unavailable/);
  assert.deepEqual(f.writes, []);
  const g = fixture(); g.deps.updateMaster = async () => {};
  await assert.rejects(refreshYouzanImages(snapshot, async () => true, g.deps), /readback/);
});
test("six-angle SKU keeps ordered first five including cover and reports the channel cap", async () => {
  const f=fixture();
  assert.deepEqual(await refreshYouzanImages({...snapshot,image_paths:Array.from({length:6},(_,i)=>`sku-listing/${i}`)},async()=>true,f.deps),{images_synced:5,images_omitted:1});
  assert.equal(f.uploaded.length,5);
  assert.match(f.uploaded[0],/sku-listing\/0$/);
});
test("default adapter emits only official HQ media contract, no branch writes or stock fields", async () => {
  state.calls=[];state.images=[];
  const deps=await createYouzanImageRefreshDeps(snapshot);
  await refreshYouzanImages(snapshot,async()=>true,deps);
  const writes=state.calls.filter((c:any)=>c.method?.endsWith('.update'));
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0],{accessToken:'fake-hq',method:'youzan.item.common.update',version:'1.0.0',
    params:{item_id:101,media:{image_ids:[1,2]},is_stock_num_edited:false},timeoutMs:30_000});
  assert.ok(state.calls.filter((c:any)=>c.method==='youzan.item.itemdetail.get').every((c:any)=>c.params.request.item_code==='ACTUAL-MASTER'));
});
test("disabled and candidate workers never claim", async () => {
  const saved={flag:process.env.YOUZAN_IMAGE_REFRESH_WORKER_ENABLED,listing:process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED,port:process.env.PORT};
  try {
    for(const [flag,listing,port] of [['false','true','3005'],['true','false','3005'],['true','true','3006'],['true','true','3000'],['true','true','']]){
      process.env.YOUZAN_IMAGE_REFRESH_WORKER_ENABLED=flag;process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED=listing;process.env.PORT=port;
      state.calls=[];assert.equal((await runYouzanImageRefreshWorker()).claimed,0);assert.deepEqual(state.calls,[]);
    }
  } finally {
    for(const [name,value] of Object.entries({YOUZAN_IMAGE_REFRESH_WORKER_ENABLED:saved.flag,HANDHELD_LISTING_IMAGE_WORKER_ENABLED:saved.listing,PORT:saved.port}))
      if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
test("live other-branch visibility blocks HQ mutation even when DB links claim exclusivity", async () => {
  state.calls=[];state.images=[];state.otherShops=[{id:'elsewhere',kdt_id:201}];
  try {
    const deps=await createYouzanImageRefreshDeps(snapshot);
    await assert.rejects(refreshYouzanImages(snapshot,async()=>true,deps),/visible_in_other_branch/);
    assert.equal(state.calls.filter((c:any)=>c.method?.endsWith('.update')).length,0);
    assert.ok(state.calls.some((c:any)=>c.params?.request?.kdt_id===201&&c.params.request.item_code==='ACTUAL-MASTER'));
  } finally { state.otherShops=[]; }
});
