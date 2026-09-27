import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
let tables: Record<string, any[]>;
let revision = 0;
let onStock: () => void | Promise<void>;
let adjustmentFails = false;
let documentManaged = false;
let adjustments: any[];
let beforeQueueWrite: (() => void) | undefined;
let readFails = false;
let staleWrites = 0;
const db = {
  from(table: string) {
    const filters: Array<(row: any) => boolean> = [];
    let patch: any;
    let single = false;
    let insert: any;
    let maxRows = Infinity;
    let descending: string | undefined;
    const q: any = {
      select: () => q, lte: () => q,
      order: (key: string, opts: any) => { if (!opts.ascending) descending = key; return q; },
      limit: (value: number) => { maxRows = value; return q; },
      eq: (key: string, value: any) => { filters.push(row => row[key] === value); return q; },
      in: (key: string, values: any[]) => { filters.push(row => values.includes(row[key])); return q; },
      update: (value: any) => { patch = value; return q; },
      insert: (value: any) => { insert = value; return q; },
      single: () => { single = true; return q; },
      maybeSingle: () => { single = true; return q; },
      then: (yes: any, no: any) => Promise.resolve().then(() => {
        assert.ok(tables[table], `Unexpected table ${table}`);
        if (table === "youzan_stock_sync_queue" && !patch && !insert && readFails) {
          return { data: null, error: { message: "queue read failed" } };
        }
        if (table === "youzan_stock_sync_queue" && (patch || insert)) beforeQueueWrite?.();
        let rows = tables[table].filter(row => filters.every(filter => filter(row)));
        if (descending) rows.sort((a, b) => String(b[descending!]).localeCompare(String(a[descending!])));
        rows = rows.slice(0, maxRows);
        if (insert) {
          if (tables[table].some(row => ["pending", "failed"].includes(row.status)
            && row.sku_id === insert.sku_id && row.shop_id === insert.shop_id)) {
            return { data: null, error: { code: "23505", message: "duplicate active request" } };
          }
          const added = { ...insert, id: `insert-${++revision}`, updated_at: `database-revision-${revision}` };
          tables[table].push(added); rows = [added];
        }
        if (patch) {
          if (!rows.length) staleWrites++;
          for (const row of rows) {
            Object.assign(row, patch);
            // Match the database BEFORE UPDATE trigger, not the caller's timestamp.
            row.updated_at = `database-revision-${++revision}`;
          }
        }
        const data = rows.map(row => structuredClone(row));
        return { data: single ? data[0] ?? null : data, error: null };
      }).then(yes, no),
    };
    return q;
  },
};
(globalThis as any).__stockQueueRace = {
  db,
  stock: async () => {
    await onStock();
    if (documentManaged) throw Error("进出存系统管理库存");
  },
  api: (input: any) => {
    if (input.method === "youzan.retail.open.spu.query") {
      return { payload: { list: [{ spu_id: 100, spu_code: "HQ", skus: [{ sku_id: 101, sku_code: "BAR" }] }] } };
    }
    if (input.method === "youzan.item.itemdetail.get") {
      return { payload: { kdt_id: 123, channel: 1, item_code: "HQ", channel_item_id: 202,
        skus: [{ channel_sku_id: 203, sku_barcode: "BAR", price: 5990 }] } };
    }
    if (input.method === "youzan.retail.open.stock.adjust") {
      adjustments.push(input.params);
      if (adjustmentFails) throw Error("timeout after remote accepted adjustment");
      return { payload: { success: true } };
    }
    if (input.method === "youzan.retail.open.query.warehousestock") {
      return { payload: [{ sku_code: "BAR", stock_num: 1 }] };
    }
    if (input.method === "youzan.item.update.delisting") { onStock(); return { payload: {} }; }
    throw Error(`Unexpected API ${input.method}`);
  },
};
const stubs: Record<string, string> = {
  "@tanstack/react-start": "export const createServerFn=()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:f=>f};return c;};",
  "@/integrations/supabase/client.server": "export const supabaseAdmin=globalThis.__stockQueueRace.db;",
  "@/integrations/supabase/auth-middleware": "export const requireSupabaseAuth={};",
  "./youzan-material-image.server": "export const prepareYouzanMaterialImage=async()=>{throw Error('unexpected image upload');};",
  "./youzan.functions": `export const ensureAccessToken=async()=>"test";
    export const getHqShop=async()=>({id:"hq",role:"hq"});
    export const callYouzanApiVerbose=async input=>globalThis.__stockQueueRace.api(input);
    export const pushYouzanQuantityUpdate=async()=>globalThis.__stockQueueRace.stock();
    export const explainYouzanError=error=>String(error);
    export const callYouzanMultipartApiVerbose=async()=>{throw Error("unexpected create");};
    export const callYouzanApiWithVersionFallback=async()=>{throw Error("unexpected create");};
    export const runYouzanShopChainProbe=async()=>{throw Error("unexpected create");};`,
};
const bundle = await build({
  entryPoints: ["src/lib/youzan-sync.functions.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "queue-boundaries", setup(builder: any) {
    builder.onResolve({ filter: /.*/ }, (args: any) => stubs[args.path]
      ? { path: args.path, namespace: "stub" }
      : args.path.startsWith("@/") ? { path: resolve(args.path.replace(/^@\//, "src/") + ".ts") } : null);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({ contents: stubs[args.path], loader: "js" }));
  } }],
});
const worker = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + "\n//# sourceURL=stock-queue-worker-test.js").toString("base64")}`);
const enqueueStubs = { ...stubs,
  "./youzan-sync.functions": "export const ensureAutoYouzanDefaultCategory=()=>{}; export const ensureHqSpuLink=()=>{}; export const runStockSyncWorkerForSkus=()=>{}; export const uploadImageToYouzanMaterial=()=>{};",
};
const enqueueBundle = await build({
  stdin: { contents: await readFile("src/lib/youzan-offline-products.functions.ts", "utf8") + "\nexport { enqueueBranchStock };",
    resolveDir: resolve("src/lib"), loader: "ts" },
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "enqueue-boundaries", setup(builder: any) {
    builder.onResolve({ filter: /.*/ }, (args: any) => enqueueStubs[args.path as keyof typeof enqueueStubs]
      ? { path: args.path, namespace: "stub" } : null);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({ contents: enqueueStubs[args.path as keyof typeof enqueueStubs], loader: "js" }));
  } }],
});
const { enqueueBranchStock } = await import(`data:text/javascript;base64,${Buffer.from(enqueueBundle.outputFiles[0].text + "\n//# sourceURL=stock-queue-enqueue-test.js").toString("base64")}`);

beforeEach(() => {
  revision = 0; documentManaged = false; adjustmentFails = false; adjustments = []; onStock = () => {};
  beforeQueueWrite = undefined; readFails = false; staleWrites = 0;
  tables = {
    youzan_stock_sync_queue: [{ id: "q", sku_id: "sku", shop_id: "branch", location_id: "loc", status: "pending",
      operation_id: "first-operation", action: "push_stock", target_stock: 1, attempts: 0, created_at: "created", updated_at: "initial" }],
    inv_skus: [{ id: "sku", status: "active", is_custom_price: true, sku_scope: "custom", stock_qty: 1 }],
    inv_stocks: [{ sku_id: "sku", location_id: "loc", qty: 1 }],
    sku_youzan_links: [
      { id: "link", sku_id: "sku", shop_id: "branch", yz_item_id: 202, yz_sku_id: 203, status: "linked", last_error: null },
      { id: "hq-link", sku_id: "sku", shop_id: "hq", yz_item_id: 100, yz_sku_id: 101 },
    ],
    youzan_shops: [{ id: "branch", role: "branch", kdt_id: 123, warehouse_code: "WH" }],
  };
});

function replaceRevision() {
  Object.assign(tables.youzan_stock_sync_queue[0], {
    status: "pending", target_stock: 0, operation_id: "replacement-operation", updated_at: "replacement-revision", attempts: 0,
  });
}

test("ordinary completion uses the database-returned claim revision", async () => {
  const result = await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(result.ok, 1);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "done");
});

test("old successful worker cannot complete a newer request or acknowledge its link", async () => {
  onStock = replaceRevision;
  const result = await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
  assert.equal(tables.youzan_stock_sync_queue[0].target_stock, 0);
  assert.equal(tables.sku_youzan_links[0].last_pushed_stock, undefined);
  assert.equal(result.ok, 0);
});

test("old failed worker cannot overwrite a newer request or poison its link", async () => {
  onStock = () => { replaceRevision(); throw Error("old request failed"); };
  await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
  assert.equal(tables.youzan_stock_sync_queue[0].attempts, 0);
  assert.equal(tables.sku_youzan_links[0].status, "linked");
  assert.equal(tables.sku_youzan_links[0].last_error, null);
});

test("archived worker cannot complete a newer queue revision", async () => {
  tables.inv_skus[0].status = "archived";
  onStock = replaceRevision;
  const result = await worker.runStockSyncWorkerForSkus(["sku"]);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
  assert.equal(tables.sku_youzan_links[0].last_pushed_stock, undefined);
  assert.equal(result.ok, 0);
});

test("warehouse timeout retry keeps the same remote operation id", async () => {
  documentManaged = true; adjustmentFails = true;
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).failed, 1);
  adjustmentFails = false;
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).ok, 1);
  assert.equal(adjustments.length, 2);
  assert.equal(adjustments[1].source_order_no, adjustments[0].source_order_no);
});

test("explicit new request at the same stock target gets a new remote operation", async () => {
  documentManaged = true;
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).ok, 1);
  replaceRevision();
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).ok, 1);
  assert.notEqual(adjustments[1].source_order_no, adjustments[0].source_order_no);
});

test("display completion cannot swallow a newer stock request", async () => {
  tables.youzan_stock_sync_queue[0].action = "push_is_display";
  onStock = replaceRevision;
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).ok, 0);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
});

const enqueueInput = { skuId: "sku", shopId: "branch", locationId: "loc", targetStock: 2 };

test("enqueue revises the running row with a fresh operation instead of inserting a successor", async () => {
  tables.youzan_stock_sync_queue[0].status = "running";
  await enqueueBranchStock(enqueueInput);
  assert.equal(tables.youzan_stock_sync_queue.length, 1);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
  assert.notEqual(tables.youzan_stock_sync_queue[0].operation_id, "first-operation");
});

test("enqueue rejects a stale read then retries against the newly claimed revision", async () => {
  beforeQueueWrite = () => {
    beforeQueueWrite = undefined;
    Object.assign(tables.youzan_stock_sync_queue[0], { status: "running", updated_at: "concurrent-claim" });
  };
  await enqueueBranchStock(enqueueInput);
  assert.equal(staleWrites, 1, "must not overwrite the version read before a concurrent claim");
  assert.equal(tables.youzan_stock_sync_queue[0].target_stock, 2);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
});

test("enqueue does not write after a failed read", async () => {
  readFails = true;
  await assert.rejects(enqueueBranchStock(enqueueInput), /queue read failed/);
  assert.equal(tables.youzan_stock_sync_queue.length, 1);
  assert.equal(tables.youzan_stock_sync_queue[0].operation_id, "first-operation");
});

test("simultaneous initial enqueues coalesce without duplicate-key loss", async () => {
  tables.youzan_stock_sync_queue = [];
  await Promise.all([enqueueBranchStock(enqueueInput), enqueueBranchStock({ ...enqueueInput, targetStock: 3 })]);
  assert.equal(tables.youzan_stock_sync_queue.length, 1);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "pending");
  assert.match(tables.youzan_stock_sync_queue[0].operation_id, /^[a-f0-9-]{36}$/);
});

test("enqueue reuses an existing pending row even if a newer done row exists", async () => {
  tables.youzan_stock_sync_queue.push({ ...tables.youzan_stock_sync_queue[0], id: "done", status: "done", updated_at: "zzz" });
  await enqueueBranchStock(enqueueInput);
  assert.equal(tables.youzan_stock_sync_queue[0].target_stock, 2);
  assert.equal(tables.youzan_stock_sync_queue[1].status, "done");
});

test("enqueue during remote work survives the old ACK and the next worker processes the new target", async () => {
  onStock = async () => {
    onStock = () => {};
    tables.inv_stocks[0].qty = 2;
    await enqueueBranchStock(enqueueInput);
  };
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).ok, 0);
  const pending = structuredClone(tables.youzan_stock_sync_queue[0]);
  assert.equal(pending.status, "pending");
  assert.equal(pending.target_stock, 2);
  assert.equal(pending.attempts, 0);
  assert.notEqual(pending.operation_id, "first-operation");
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).ok, 1);
  assert.equal(tables.youzan_stock_sync_queue[0].status, "done");
  assert.equal(tables.youzan_stock_sync_queue[0].operation_id, pending.operation_id);
  assert.equal(tables.sku_youzan_links[0].last_pushed_stock, 2);
});

test("concurrent enqueues on a failed row reset attempts and serialize fresh operations", async () => {
  Object.assign(tables.youzan_stock_sync_queue[0], { status: "failed", attempts: 4 });
  await Promise.all([enqueueBranchStock(enqueueInput), enqueueBranchStock({ ...enqueueInput, targetStock: 3 })]);
  assert.equal(tables.youzan_stock_sync_queue.length, 1);
  assert.ok(staleWrites > 0);
  assert.equal(tables.youzan_stock_sync_queue[0].target_stock, 3);
  assert.equal(tables.youzan_stock_sync_queue[0].attempts, 0);
  assert.notEqual(tables.youzan_stock_sync_queue[0].operation_id, "first-operation");
});

test("enqueue bounds CAS contention without an unguarded fallback", async () => {
  beforeQueueWrite = () => { tables.youzan_stock_sync_queue[0].updated_at = `contender-${++revision}`; };
  await assert.rejects(enqueueBranchStock(enqueueInput), /并发更新/);
  assert.equal(staleWrites, 5);
  assert.equal(tables.youzan_stock_sync_queue[0].target_stock, 1);
});

test("worker does not push stock without the operation ID migration", async () => {
  delete tables.youzan_stock_sync_queue[0].operation_id;
  let called = false;
  onStock = () => { called = true; };
  assert.equal((await worker.runStockSyncWorkerForSkus(["sku"])).failed, 1);
  assert.equal(called, false);
  assert.match(tables.youzan_stock_sync_queue[0].last_error, /migration required/);
});
