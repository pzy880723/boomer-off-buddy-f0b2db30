import assert from "node:assert/strict";
import {test} from "node:test";
import {recordOrderOrigin} from "./order-origin.server.ts";

test("missing client source remains unknown, not app", async () => {
  const store = {rpc: async () => {throw new Error("unexpected write");}};
  assert.equal(await recordOrderOrigin(store,{orderId:"o",customerId:"c"}),null);
});
test("only allow declared consumer platforms and preserve RPC result on replay", async () => {
  const calls: unknown[] = [];
  const stored = {version:1,platform:"miniapp",evidence:"client_reported"};
  const store = {rpc: async (name: string,args: Record<string,unknown>) => {calls.push([name,args]); return {data:stored,error:null};}};
  assert.equal(await recordOrderOrigin(store,{orderId:"o",customerId:"c",platform:"app"}),stored);
  assert.deepEqual(calls,[["commerce_record_order_origin",{p_order_id:"o",p_customer_id:"c",p_platform:"app",p_evidence:"client_reported"}]]);
  await assert.rejects(recordOrderOrigin(store,{orderId:"o",customerId:"c",platform:"delivery"}),/Unsupported/);
  assert.equal(calls.length,1);
});
test("recording errors cannot silently report successful source persistence", async () => {
  await assert.rejects(recordOrderOrigin({rpc:async()=>({data:null,error:{message:"offline"}})},
    {orderId:"o",customerId:"c",platform:"miniapp",evidence:"verified_miniapp_payment"}),/offline/);
});
