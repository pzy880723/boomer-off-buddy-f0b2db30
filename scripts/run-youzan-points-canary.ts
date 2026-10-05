// Manual, explicitly authorized one-point canary. Run under an exclusive flock.
// Never scheduled or imported by the app. A persisted run cannot seed twice.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { youzanFetch } from "../src/lib/youzan-http";
import { selectPointsHeadquarters, createYouzanPointsQuery } from "../src/server/youzan-points-query.server";
import { createYouzanPointsOperation, type PointsOperation } from "../src/server/youzan-points-operation.server";
import { runProductionPointsOperation } from "../src/server/youzan-points-operation-production.server";

const path = "/var/lib/boomer-off/youzan-one-point-canary-20261005.json";
const stages = ["prepare", "seed", "debit", "replay", "refund", "cleanup", "verify"];
const stage = process.argv[2];
assert.ok(stages.includes(stage), "invalid_canary_stage");
assert.equal(process.env.YOUZAN_ONE_POINT_CANARY_AUTHORIZED, "20261005-original-test-member-restore-zero");
assert.ok(/^https?:\/\//.test(process.env.YOUZAN_PROXY_URL ?? "") && process.env.YOUZAN_PROXY_TOKEN);
const db = new DatabaseSync("/var/lib/boomer-off/membership-youzan-links.sqlite", { readOnly: true });
const links = db.prepare("SELECT customer_id,kdt_id,yz_id FROM member_channel_links").all() as Array<{customer_id:string;kdt_id:number;yz_id:string}>;
db.close();
assert.equal(links.length, 1, "canary_requires_original_single_mapping");
const member = links[0];
const shops = await supabaseAdmin.from("youzan_shops").select("kdt_id,parent_kdt_id,role,status,access_token,token_expires_at").eq("status", "active");
assert.equal(shops.error, null);
const head = selectPointsHeadquarters(shops.data ?? [], Number(member.kdt_id));
assert.ok(head, "headquarters_not_available");
const wallet = async () => {
  const r = await supabaseAdmin.from("pos_customer_wallets").select("points").eq("customer_id", member.customer_id).single();
  assert.equal(r.error, null); return r.data!.points;
};
const query = createYouzanPointsQuery({ getAccessToken: async () => head.access_token!, proxyConfigured: () => true, fetchImpl: youzanFetch });
const balance = async () => {
  const r = await query({ assetKind: "points", kdtId: head.kdt_id, yzOpenId: member.yz_id, assetKey: "" });
  assert.equal(r.kind, "ok", "canary_balance_unavailable");
  return (r as {observed:{point:number}}).observed.point;
};
type State = { runId:string; customerId:string; yzId:string; headId:number; sourceId:number;
  baseline:number; localBaseline:number; seedId:string; completed:string[]; started?:string;
  debitId?:string; refundId?:string; cleanupId?:string; results:Record<string,unknown> };
const save = (s: State) => {
  const fd = openSync(`${path}.tmp`, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${path}.tmp`, path);
  const parent = openSync("/var/lib/boomer-off", "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
};
if (stage === "prepare" && !existsSync(path)) {
  assert.equal(await balance(), 0); assert.equal(await wallet(), 3000);
  save({ runId:randomUUID(), customerId:member.customer_id, yzId:member.yz_id,
    headId:head.kdt_id, sourceId:Number(member.kdt_id), baseline:0, localBaseline:3000,
    seedId:randomUUID(), completed:["prepare"], results:{} });
}
assert.ok(existsSync(path), "prepare_required");
const s: State = JSON.parse(readFileSync(path, "utf8"));
assert.equal(s.customerId, member.customer_id); assert.equal(s.yzId, member.yz_id);
assert.equal(s.headId, head.kdt_id); assert.equal(s.sourceId, Number(member.kdt_id));
assert.equal(await wallet(), s.localBaseline, "local_wallet_changed_stop");
if (!s.completed.includes(stage)) {
  assert.equal(s.completed.at(-1), stages[stages.indexOf(stage)-1], "stage_out_of_order");
  if (!s.started) assert.equal(await balance(), ({seed:0,debit:1,replay:0,refund:0,cleanup:1,verify:0} as Record<string,number>)[stage], "unexpected_balance_stop");
  else assert.equal(s.started, stage);
  s.started = stage; save(s);
  process.env.YOUZAN_POINTS_WRITE_ENABLED = "true";
  process.env.YOUZAN_POINTS_WRITE_CUSTOMER_IDS = member.customer_id;
  let result: unknown;
  if (stage === "seed") {
    const r = await youzanFetch(`https://open.youzanyun.com/api/youzan.crm.customer.points.increase/4.0.0?access_token=${encodeURIComponent(head.access_token!)}`, {
      method:"POST", headers:{"content-type":"application/json"}, signal:AbortSignal.timeout(15000),
      body:JSON.stringify({ params:{ user:{account_id:s.yzId,account_type:5}, points:1,
        biz_value:`boomer-canary:${s.seedId}`,biz_token:"authorized_test_seed",
        reason:"Authorized one-point integration test; restore original balance",is_do_ext_point:false,
        check_customer:true,source_kdt_id:s.sourceId } }),
    });
    const j = await r.json();
    result = { http:r.status, code:j.code, success:j.success, confirmed:j.data?.is_success === true || j.data?.is_success === "true" };
    s.results[stage] = result; save(s);
    assert.ok(r.ok && j.code === 200 && j.success === true && (result as {confirmed:boolean}).confirmed, "seed_unconfirmed_stop");
  } else if (stage === "replay") {
    const original = s.results.debit as {kind:string;operationId:string};
    assert.equal(original.kind, "succeeded"); assert.equal(original.operationId, s.debitId);
    const op: PointsOperation = { id:s.debitId!,customer_id:s.customerId,kdt_id:s.headId,source_kdt_id:s.sourceId,yz_open_id:s.yzId,points:1,kind:"debit" };
    const execute = createYouzanPointsOperation({writesEnabled:()=>true,customerAllowed:id=>id===s.customerId,
      proxyConfigured:()=>true,resolveHeadquartersToken:async()=>head.access_token!,fetchImpl:youzanFetch});
    result = await execute(op);
    s.results[stage] = result; save(s);
    const replay = result as {kind:string;reason?:string};
    assert.ok(replay.kind === "succeeded" || (replay.kind === "unknown" && replay.reason === "remote_operation_duplicate"), "remote_duplicate_unconfirmed_stop");
  } else if (stage !== "verify") {
    const r = await runProductionPointsOperation({operationKey:`canary:${s.runId}:${stage}`,customerId:s.customerId,
      sourceKdtId:s.sourceId,kind:stage==="refund"?"refund":"debit",points:1,
      ...(stage==="refund"?{parentId:s.debitId}:{})});
    result = r; s.results[stage] = r; save(s);
    assert.equal(r.kind, "succeeded", "journal_operation_unconfirmed_stop");
    const id = (r as {operationId:string}).operationId;
    if (stage === "debit") s.debitId = id;
    if (stage === "refund") s.refundId = id;
    if (stage === "cleanup") s.cleanupId = id;
  }
  const expected = stage === "seed" || stage === "refund" ? 1 : 0;
  // Provider reads may lag slightly; no additional writes while observing.
  let current = await balance();
  for (let i=0; current!==expected && i<5; i++) {
    await new Promise(r=>setTimeout(r,2000)); current=await balance();
  }
  assert.equal(current, expected, "balance_verification_failed_stop");
  assert.equal(await wallet(), s.localBaseline);
  s.completed.push(stage); delete s.started; save(s);
}
const finalBalance = await balance();
if (stage === "verify") assert.equal(finalBalance, s.baseline, "remote_baseline_not_restored");
console.log(JSON.stringify({stage,completed:s.completed,remoteBalance:finalBalance,erpBalance:await wallet(),
  otherMembersTouched:0,couponMutations:0,realPayments:0}));
