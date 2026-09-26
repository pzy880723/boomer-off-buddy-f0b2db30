import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = {};
const originalWorkerFlag = process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
after(() => {
  if (originalWorkerFlag === undefined) delete process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
  else process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = originalWorkerFlag;
});
(globalThis as any).__contentJobs = state;
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": `export const supabaseAdmin={
    rpc:async(name,args)=>{const s=globalThis.__contentJobs;s.calls.push({name,args});
      if(name==='product_content_image_finish' && args.p_id===s.finishError) return {data:null,error:{message:'completion unavailable'}};
      if(name==='product_content_image_claim' && s.claimError) return {data:null,error:{message:'claim unavailable'}};
      return name==='product_content_image_claim'?{data:s.jobs,error:null}:{data:'succeeded',error:null};},
    from:table=>{const s=globalThis.__contentJobs;let update=null;const q={select:()=>q,in:()=>q,lte:()=>q,order:()=>q,
      update:value=>{update=value;s.writes.push({table,value});return q;},eq:()=>q,
      maybeSingle:async()=>({data:{id:'legacy'},error:null}),
      then:r=>Promise.resolve({data:update?null:[{status:'succeeded'}],error:null}).then(r),
      limit:async()=>{await s.legacyGate;return {data:s.legacyJobs,error:s.legacyError?{message:'legacy unavailable'}:null};}};return q;},
    storage:{from:bucket=>({
      createSignedUrl:async(path)=>{const s=globalThis.__contentJobs;s.signed.push({bucket,path});return {data:{signedUrl:'https://raw'},error:null};},
      upload:async(path,bytes,options)=>{const s=globalThis.__contentJobs;s.uploads.push({bucket,path,bytes,options});return {error:null};}
    })}
  };`,
  "@/server/handheld-ai.server": `export const aiPrepareListingImage=async input=>{const s=globalThis.__contentJobs;s.prepared.push(input);if(s.fail)throw new Error('ruler service failed');return {b64:'cHJvdGVjdGVk',mime:'image/png'};};`,
};
const bundle = await build({
  entryPoints: ["src/server/handheld-listing-image-jobs.server.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "stubs",
      setup(b: any) {
        b.onResolve({ filter: /^@\// }, (a: any) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({
          contents: stubs[a.path],
          loader: "js",
        }));
      },
    },
  ],
});
const worker = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const job = {
  id: "job",
  sku_id: "sku",
  source_path: "sku-raw/date/device/detail.jpg",
  block_id: "detail",
  claim_token: "claim",
  attempts: 1,
};
beforeEach(() => {
  process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = "true";
  Object.assign(state, {
    jobs: [job],
    legacyJobs: [],
    writes: [],
    calls: [],
    signed: [],
    uploads: [],
    prepared: [],
    fail: false,
    legacyGate: undefined,
    legacyError: false,
    claimError: false,
    finishError: undefined,
  });
});
test("content finishes while the legacy queue is still blocked", async () => {
  let release!: () => void;
  state.legacyGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = worker.runListingImageWorker(2);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(state.calls.some((call: any) => call.name === "product_content_image_finish"));
  } finally {
    release();
    await pending;
  }
});
test("legacy queue failure does not suppress successful content outcomes", async () => {
  state.legacyError = true;
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 1, failed: 1 });
});
test("content claim failure does not suppress successful legacy outcomes", async () => {
  state.claimError = true;
  state.legacyJobs = [
    {
      id: "legacy",
      sku_id: "sku",
      source_bucket: "sku-raw",
      source_path: "gallery.jpg",
      source_index: 0,
      attempts: 0,
    },
  ];
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 1, failed: 1 });
  assert.ok(state.calls.some((call: any) => call.name === "handheld_apply_listing_image_result"));
});
test("one content completion error retains sibling completion counts", async () => {
  state.jobs = [{ ...job, id: "bad" }, job];
  state.finishError = "bad";
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 1, failed: 1 });
  assert.equal(
    state.calls.filter((call: any) => call.name === "product_content_image_finish").length,
    2,
  );
});
test("disabled worker entrypoint and inline publish trigger do not claim, sign or prepare jobs", async () => {
  process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = "false";
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0 });
  worker.triggerListingImageWorker(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.signed, []);
  assert.deepEqual(state.prepared, []);
});
test("unset worker flag keeps backward-compatible direct execution", async () => {
  delete process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
  assert.equal((await worker.runListingImageWorker(2)).processed, 1);
});
for (const [limit, expected] of [
  [NaN, 2],
  [Infinity, 2],
  [-Infinity, 2],
  [2.9, 2],
  [-1, 1],
  [99, 6],
])
  test(`direct worker sanitizes batch limit ${limit}`, async () => {
    await worker.runListingImageWorker(limit);
    assert.equal(
      state.calls.find((call: any) => call.name === "product_content_image_claim").args.p_limit,
      expected,
    );
  });
test("existing worker drains durable detail jobs through shared ruler-safe preparation and fenced completion", async () => {
  const result = await worker.runListingImageWorker(2);
  assert.equal(result.processed, 1);
  assert.deepEqual(state.prepared, [{ image_url: "https://raw" }]);
  assert.deepEqual(state.signed, [{ bucket: "sku-raw", path: "date/device/detail.jpg" }]);
  assert.equal(state.uploads[0].bucket, "sku-listing");
  assert.equal(state.uploads[0].bytes.toString(), "protected");
  const finish = state.calls.find((call: any) => call.name === "product_content_image_finish");
  assert.equal(finish.args.p_id, job.id);
  assert.equal(finish.args.p_claim_token, job.claim_token);
  assert.equal(finish.args.p_target_path, `sku-listing/${state.uploads[0].path}`);
  assert.equal(finish.args.p_error, null);
  assert.equal(
    state.calls.some((call: any) => call.name === "handheld_apply_listing_image_result"),
    false,
  );
  assert.deepEqual(
    state.writes,
    [],
    "Detail jobs never update SKU image state or legacy queue rows",
  );
});
test("preparation failure is durably retried without changing content or pretending raw is optimized", async () => {
  state.fail = true;
  await worker.runListingImageWorker(2);
  assert.deepEqual(state.uploads, []);
  const finish = state.calls.find((call: any) => call.name === "product_content_image_finish");
  assert.equal(finish.args.p_target_path, null);
  assert.match(finish.args.p_error, /ruler service failed/);
});

test("legacy gallery jobs still apply their SKU result and refresh status after shared preparation", async () => {
  state.jobs = [];
  state.legacyJobs = [
    {
      id: "legacy",
      sku_id: "sku",
      source_bucket: "sku-raw",
      source_path: "date/device/gallery.jpg",
      source_index: 0,
      attempts: 0,
    },
  ];
  assert.equal((await worker.runListingImageWorker(2)).processed, 1);
  const apply = state.calls.find(
    (call: any) => call.name === "handheld_apply_listing_image_result",
  );
  assert.equal(apply.args.p_source_key, "sku-raw/date/device/gallery.jpg");
  assert.equal(apply.args.p_target_key, `sku-listing/${state.uploads[0].path}`);
  assert.ok(
    state.writes.some(
      (write: any) =>
        write.table === "inv_listing_image_jobs" && write.value.status === "succeeded",
    ),
  );
  assert.ok(
    state.writes.some(
      (write: any) =>
        write.table === "inv_skus" && write.value.image_processing_status === "succeeded",
    ),
  );
});
