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
  "@/server/listing-readiness.server": "export const advanceListingReadiness=async()=>({status:'legacy'}); export const advanceListingReadinessSafe=async()=>{}; export const currentReadinessRevision=async()=>null; export const sweepListingReadiness=async()=>({checked:0});",
  "@/integrations/supabase/client.server": `export const supabaseAdmin={
    rpc:async(name,args)=>{const s=globalThis.__contentJobs;s.calls.push({name,args});
      if(name==='handheld_listing_image_claim'){await s.legacyGate;return {data:s.legacyJobs,error:s.legacyError?{message:'legacy unavailable'}:null};}
      if(name==='handheld_listing_image_finish')return {data:s.legacyFinishStatus??(args.p_error?'retryable_failed':'succeeded'),error:s.legacyFinishError?{message:'legacy completion unavailable'}:null};
      if(name==='product_content_image_finish' && args.p_id===s.finishError) return {data:null,error:{message:'completion unavailable'}};
      if(name==='product_content_image_claim' && s.claimError) return {data:null,error:{message:'claim unavailable'}};
      return name==='product_content_image_claim'?{data:s.jobs,error:null}:{data:(name==='product_content_image_finish'&&s.contentFinishStatus)?s.contentFinishStatus:'succeeded',error:null};},
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
  "@/server/handheld-ai.server": `export const aiPrepareListingImage=async (input,guard)=>{const s=globalThis.__contentJobs;await guard.check('image_generation');s.prepared.push(input);if(s.fail)throw new Error('ruler service failed');return {b64:'cHJvdGVjdGVk',mime:'image/png'};};`,
  "@/server/ai-consent.server": `export const dbConsentStore=()=>({get:async()=>true});`,
  "@/server/ai-consent-core": `export const QUEUED_AI_DENIED_ERROR='ai_consent_missing';export const QUEUED_AI_UNAVAILABLE_ERROR='ai_consent_unavailable';
    export const queuedAiDecision=async(s,j)=>j.ai_actor_user_id?((await s.get())?'allowed':'denied'):'denied';
    export const isAiConsentRevoked=e=>!!e&&e.code==='ai_consent_revoked';
    export const handheldAiGuard=(s,a)=>({kind:'handheld_staff',check:async(stage)=>{const d=await queuedAiDecision(s,{ai_actor_user_id:a.userId});if(d!=='allowed'){const e=new Error(d);e.code='ai_consent_revoked';e.reason=d;throw e;}}});`,
  "@/server/listing-image-safety.server": `export const safeImageJobError=e=>((e&&e.stage?"["+e.stage+"] ":"")+(e instanceof Error?e.message:String(e))).slice(0,1000); export const retryInstructionFromError=e=>typeof e==="string"&&e.includes("fields=outer_bag_removed")?"FIXED_HINT_outer_bag":undefined;`,
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
  ai_actor_user_id: "u1",
  ai_policy_version: "2026-10-09-v1",
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
    legacyFinishError: false,
    legacyFinishStatus: undefined,
    contentFinishStatus: undefined,
  });
});
const galleryJob = {
  id: "legacy", sku_id: "sku", source_bucket: "sku-raw", source_path: "gallery.jpg", source_index: 0,
  ai_actor_user_id: "u1", ai_policy_version: "2026-10-09-v1", attempts: 0,
};
test("gallery runs first; claimed gallery jobs skip detail claim this round", async () => {
  state.legacyJobs = [galleryJob];
  assert.deepEqual(await worker.runListingImageWorker(6), { processed: 1 });
  assert.ok(!state.calls.some((call: any) => call.name === "product_content_image_claim"));
});
test("concurrent hook + timer share one single-flight batch (cap 6, no doubling)", async () => {
  let release!: () => void;
  state.legacyGate = new Promise<void>((resolve) => { release = resolve; });
  state.legacyJobs = Array.from({ length: 6 }, (_, i) => ({ ...galleryJob, id: `g${i}`, source_index: i }));
  const a = worker.runListingImageWorker(6);
  const b = worker.runListingImageWorker(6);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, { processed: 6 });
  assert.equal(ra, rb);
  assert.equal(state.calls.filter((c: any) => c.name === "handheld_listing_image_claim").length, 1);
  assert.equal(state.prepared.length, 6);
});
test("detail retryable/permanent/stale/cancelled are never counted as success", async () => {
  for (const [status, expected] of [
    ["retryable_failed", { processed: 0, failed: 1 }], ["permanent_failed", { processed: 0, failed: 1 }],
    ["stale", { processed: 0 }], ["cancelled", { processed: 0 }],
  ] as const) {
    state.contentFinishStatus = status;
    assert.deepEqual(await worker.runListingImageWorker(6), expected, status);
  }
  state.contentFinishStatus = undefined;
});
test("legacy queue failure does not suppress successful content outcomes", async () => {
  state.legacyError = true;
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 1, failed: 1 });
});
test("content claim failure is counted as failure when gallery is empty", async () => {
  state.claimError = true;
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0, failed: 1 });
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
      ai_actor_user_id: "u1",
      ai_policy_version: "2026-10-09-v1",
      attempts: 0,
      claim_token: "legacy-claim",
    },
  ];
  assert.equal((await worker.runListingImageWorker(2)).processed, 1);
  const apply = state.calls.find(
    (call: any) => call.name === "handheld_listing_image_finish",
  );
  assert.equal(apply.args.p_id, "legacy");
  assert.equal(apply.args.p_claim_token, "legacy-claim");
  assert.equal(apply.args.p_target_path, `sku-listing/${state.uploads[0].path}`);
  assert.equal(apply.args.p_error, null);
  assert.deepEqual(state.writes, [], "Only the owner-fenced SQL transaction may apply and finish");
  assert.equal(state.calls.some((call: any) => call.name === "handheld_apply_listing_image_result"), false);
});

function legacyOnly() {
  state.jobs = [];
  state.legacyJobs = [{ id: "legacy", sku_id: "sku", source_bucket: "sku-raw", source_path: "gallery.jpg", source_index: 0, attempts: 1, claim_token: "owner", ai_actor_user_id: "u1", ai_policy_version: "2026-10-09-v1" }];
}
test("legacy completion failure is visible and leaves recovery to the lease", async () => {
  legacyOnly(); state.legacyFinishError = true;
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0, failed: 1 });
  assert.deepEqual(state.writes, []);
});
test("legacy preparation errors are durably finished as failures, never raw-success", async () => {
  legacyOnly(); state.fail = true;
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0, failed: 1 });
  const finish = state.calls.find((c: any) => c.name === "handheld_listing_image_finish");
  assert.equal(finish.args.p_target_path, null);
  assert.match(finish.args.p_error, /ruler service failed/);
  assert.deepEqual(state.uploads, []);
});
test("removed source completion is reported as failed rather than successful", async () => {
  legacyOnly(); state.legacyFinishStatus = "permanent_failed";
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0, failed: 1 });
});
test("stale owner cannot report a completed legacy job", async () => {
  legacyOnly(); state.legacyFinishStatus = "stale";
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0 });
  assert.deepEqual(state.writes, []);
});
test("unrecognized legacy completion response is not accepted", async () => {
  legacyOnly(); state.legacyFinishStatus = "unexpected";
  assert.deepEqual(await worker.runListingImageWorker(2), { processed: 0, failed: 1 });
});

test("gallery and detail retries pass only the fixed hint derived from last_error", async () => {
  const leak = "修图检查未通过（fields=outer_bag_removed; confidence=0.97） https://x.test/a?token=1 13800000000";
  state.legacyJobs = [{ ...galleryJob, last_error: leak }];
  await worker.runListingImageWorker(6);
  state.legacyJobs = [];
  state.jobs = [{ ...job, last_error: leak }];
  await worker.runListingImageWorker(6);
  assert.equal(state.prepared.length, 2);
  for (const p of state.prepared) {
    assert.equal(p.instruction, "FIXED_HINT_outer_bag");
    assert.doesNotMatch(JSON.stringify(p), /token|13800000000|x\.test\/a/);
  }
});
