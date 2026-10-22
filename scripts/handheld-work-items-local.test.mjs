import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { build } = createRequire(createRequire(import.meta.url).resolve("vite"))("esbuild");
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333",
  T = "44444444-4444-4444-8444-444444444444",
  S = "55555555-5555-4555-8555-555555555555";
const counts = { customers: 104, internal: 2, orders: 3, system: 1, total: 110 };
const state = {};
globalThis.__workItemsLocal = state;
beforeEach(() =>
  Object.assign(state, {
    calls: [],
    reads: [],
    store: A,
    taskStore: A,
    hasMore: true,
    autoFilter: false,
    lastTs: "2026-10-18T01:00:00.123456+00:00",
    lastId: C,
    items: [
      {
        id: C,
        type: "support",
        title: "尺寸咨询",
        description: "待测量",
        action: "support_conversation",
        target_id: C,
        conversation_id: C,
        sku_id: S,
        private_key: "never-return",
      },
    ],
    generalLocations: [A],
    supportLocations: [A],
    generalHq: false,
    supportHq: false,
  }),
);
const client = `export const supabaseAdmin={rpc:async(name,args)=>{const s=globalThis.__workItemsLocal;s.calls.push({name,args});let items=s.items;if(s.autoFilter)items=items.filter(r=>r.fixture_category==='support'?(args.p_support_location_ids??[]).includes(r.fixture_location):(args.p_location_ids??[]).includes(r.fixture_location));return {error:null,data:name.includes('pending_counts')?${JSON.stringify(counts)}:{items,counts:${JSON.stringify(counts)},has_more:s.hasMore,last_ts:s.lastTs,last_id:s.lastId}};},from(table){const s=globalThis.__workItemsLocal;s.reads.push(table);const chain={select:()=>chain,eq:()=>chain,in:()=>chain,maybeSingle:()=>chain,then(resolve){const rows={inv_locations:[{id:'${A}'},{id:'${B}'}],support_conversations:[{id:'${C}',customer_id:'customer',location_id:s.store}],product_measurement_requesters:[{task_id:'${T}',customer_id:'customer',conversation_id:'${C}'}],product_measurement_tasks:[{id:'${T}',sku_id:'${S}',listing_id:null,location_id:s.taskStore,status:'pending'}],inv_skus:[{id:'${S}',name:'小熊',image_paths:['private/sku.png'],measurement_revision:1}]};return Promise.resolve({data:rows[table]??[],error:null}).then(resolve);}};return chain;}};`;
const out = path.resolve(".tmp-tests/handheld-work-items-local.mjs");
await mkdir(path.dirname(out), { recursive: true });
let moduleError = null,
  api;
try {
  await build({
    entryPoints: ["src/server/handheld-work-items.server.ts"],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
    plugins: [
      {
        name: "isolation",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            a.path === "@/integrations/supabase/client.server"
              ? { path: "client", namespace: "stub" }
              : a.path.endsWith("handheld-notifications.server")
                ? { path: "scope", namespace: "stub" }
                : a.path.endsWith("/support.server") || a.path === "./support.server"
                  ? { path: "support", namespace: "stub" }
                  : a.path.endsWith("media-derivative.server")
                    ? { path: "media", namespace: "stub" }
                    : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
            contents:
              a.path === "client"
                ? client
                : a.path === "scope"
                  ? `export const effectiveLocationIds=s=>s.filter_location_id?[s.filter_location_id]:s.location_ids;export const resolveNotificationScope=async input=>({user_id:input.userId,device_id:input.deviceId,device_location_id:input.deviceLocationId,location_ids:globalThis.__workItemsLocal.generalLocations,is_hq:globalThis.__workItemsLocal.generalHq});`
                  : a.path === "support"
                    ? `export const resolveSupportAccess=async()=>({is_hq_agent:globalThis.__workItemsLocal.supportHq,location_ids:globalThis.__workItemsLocal.supportLocations});`
                    : `export const DERIVATIVE_WIDTHS={thumbnail:320};export const signDerivativeUrls=async paths=>paths.map(()=> 'https://media.example/thumb.png');`,
            loader: "ts",
          }));
        },
      },
    ],
  });
  api = await import(pathToFileURL(out).href + `?${Date.now()}`);
} catch (error) {
  moduleError = error;
}
const scope = {
  user_id: "employee",
  device_id: "device",
  device_location_id: A,
  location_ids: [A],
  is_hq: false,
  support_location_ids: [A],
  support_include_unlocated: false,
};
function ready() {
  assert.equal(moduleError, null, "work-items module must use existing safe measurement helper");
}
test("work-items module integrates existing measurement helper", ready);
test("one-item page keeps full counts and safe image, never raw RPC fields", async () => {
  ready();
  const page = await api.loadWorkItems(scope, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.counts.total, 110);
  assert.equal(page.items[0].image_url, "https://media.example/thumb.png");
  assert.equal(JSON.stringify(page).includes("private"), false);
  assert.equal(state.calls[0].name, "handheld_work_items_scoped");
});
test("next cursor preserves database microseconds and passes unchanged to SQL", async () => {
  ready();
  const page = await api.loadWorkItems(scope, 1);
  assert.equal(page.next_cursor, `${state.lastTs}|${C}`);
  await api.loadWorkItems(scope, 1, page.next_cursor);
  assert.equal(state.calls[1].args.p_cursor_ts, state.lastTs);
});
test("HQ explicit location cannot hydrate another store's image", async () => {
  ready();
  state.store = B;
  const page = await api.loadWorkItems({
    ...scope,
    is_hq: true,
    location_ids: [A, B],
    filter_location_id: A,
  });
  assert.equal(page.items[0].image_url, null);
  assert.equal(state.reads.includes("inv_skus"), false);
  assert.deepEqual(state.calls[0].args.p_location_ids, [A]);
  assert.equal(state.calls[0].args.p_include_unlocated, false);
});
test("orphan measurement image needs authorized task matching this SKU", async () => {
  ready();
  state.items = [
    {
      id: T,
      type: "measurement",
      title: "尺寸测量",
      description: "待测量",
      action: "measurement_task",
      target_id: T,
      sku_id: S,
    },
  ];
  let page = await api.loadWorkItems(scope);
  assert.equal(page.items[0].image_url, "https://media.example/thumb.png");
  state.taskStore = B;
  state.reads = [];
  page = await api.loadWorkItems(scope);
  assert.equal(page.items[0].image_url, null);
  assert.equal(state.reads.includes("inv_skus"), false);
});
test("count-only path has full scope and never reads photos", async () => {
  ready();
  const result = await api.loadPendingCounts({ ...scope, is_hq: true, location_ids: [A, B] });
  assert.equal(result.total, 110);
  assert.equal(state.calls[0].args.p_include_unlocated, true);
  assert.deepEqual(state.reads, []);
  assert.equal(state.calls[0].name, "handheld_pending_counts_scoped");
});
test("malformed next-page contract fails closed instead of silently losing rows", async () => {
  ready();
  state.lastTs = "bad";
  await assert.rejects(() => api.loadWorkItems(scope), /cursor|contract/);
});
test("support HQ-only scope never receives general orders/internal rights", async () => {
  ready();
  state.generalLocations = [];
  state.supportLocations = [];
  state.supportHq = true;
  const result = await api.resolveWorkScope({
    userId: "support-hq",
    deviceId: "device",
    deviceLocationId: null,
  });
  await api.loadPendingCounts(result);
  assert.deepEqual(state.calls[0].args.p_location_ids, []);
  assert.equal(state.calls[0].args.p_include_unlocated, false);
  assert.deepEqual(state.calls[0].args.p_support_location_ids, [A, B]);
  assert.equal(state.calls[0].args.p_support_include_unlocated, true);
});
test("general A and support B stay separate even when B is explicitly selected", async () => {
  ready();
  state.supportLocations = [B];
  state.store = B;
  state.taskStore = B;
  const result = await api.resolveWorkScope({
    userId: "mixed",
    deviceId: "device",
    deviceLocationId: A,
  });
  const selected = api.applyWorkLocation(result, B);
  assert.equal(selected.ok, true);
  await api.loadWorkItems(selected.scope);
  assert.deepEqual(state.calls[0].args.p_location_ids, []);
  assert.deepEqual(state.calls[0].args.p_support_location_ids, [B]);
  assert.equal(state.calls[0].args.p_include_unlocated, false);
  assert.equal(state.calls[0].args.p_support_include_unlocated, false);
  assert.equal(api.applyWorkLocation(result, "66666666-6666-4666-8666-666666666666").ok, false);
});
test("support B customer image is allowed but B order stays excluded by separate SQL scope", async () => {
  ready();
  state.supportLocations = [B];
  state.store = B;
  state.taskStore = B;
  state.autoFilter = true;
  state.items = [
    { ...state.items[0], fixture_category: "support", fixture_location: B },
    {
      id: T,
      type: "commerce_pick",
      title: "B订单不可见",
      description: "待发货",
      action: "fulfillment_detail",
      target_id: T,
      fixture_category: "order",
      fixture_location: B,
    },
  ];
  const result = await api.resolveWorkScope({
    userId: "mixed",
    deviceId: "device",
    deviceLocationId: A,
  });
  const page = await api.loadWorkItems(result);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].type, "support");
  assert.equal(page.items[0].image_url, "https://media.example/thumb.png");
  assert.equal(JSON.stringify(page).includes("private/"), false);
  assert.deepEqual(state.calls[0].args.p_location_ids, [A]);
  assert.deepEqual(state.calls[0].args.p_support_location_ids, [B]);
});
test("explicit general A selection excludes support-only B and HQ-null customer branches", async () => {
  ready();state.supportLocations=[B];state.supportHq=false;
  const base=await api.resolveWorkScope({userId:'mixed',deviceId:'device',deviceLocationId:A});
  const selected=api.applyWorkLocation(base,A);assert.equal(selected.ok,true);
  await api.loadPendingCounts(selected.scope);
  assert.deepEqual(state.calls[0].args.p_location_ids,[A]);
  assert.deepEqual(state.calls[0].args.p_support_location_ids,[]);
  assert.equal(state.calls[0].args.p_include_unlocated,false);
  assert.equal(state.calls[0].args.p_support_include_unlocated,false);
});
test("service-only B selection never grants an orphan measurement's private image", async () => {
  ready();state.supportLocations=[B];state.taskStore=B;state.items=[{id:T,type:'measurement',title:'孤立测量',description:'待测量',action:'measurement_task',target_id:T,sku_id:S}];
  const base=await api.resolveWorkScope({userId:'mixed',deviceId:'device',deviceLocationId:A});
  const selected=api.applyWorkLocation(base,B);assert.equal(selected.ok,true);
  const page=await api.loadWorkItems(selected.scope);
  assert.deepEqual(state.calls[0].args.p_location_ids,[]);
  assert.equal(page.items[0].image_url,null);assert.equal(state.reads.includes('inv_skus'),false);
});
