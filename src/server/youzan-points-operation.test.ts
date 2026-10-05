import test from "node:test";
import assert from "node:assert/strict";
import { createYouzanPointsOperation, processPointsOperation, type PointsOperation } from "./youzan-points-operation.server";

const operation: PointsOperation = {
  id: "9089b21c-210f-46a8-a71b-d615814ef015", customer_id: "member-test",
  kdt_id: 123, source_kdt_id: 456, yz_open_id: "trusted-member", kind: "debit", points: 1,
};
function setup(result: unknown = { code: 200, success: true, data: { is_success: "true" } }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deps = {
    writesEnabled: () => true,
    customerAllowed: (id: string) => id === operation.customer_id,
    proxyConfigured: () => true,
    resolveHeadquartersToken: async (head: number, source: number) => head === 123 && source === 456 ? "private-token" : null,
    fetchImpl: async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(result); },
  };
  return { calls, deps, run: createYouzanPointsOperation(deps) };
}

test("writes are disabled by default and require an explicit customer allowlist", async () => {
  for (const guard of ["writesEnabled", "customerAllowed", "proxyConfigured"] as const) {
    const { calls, deps } = setup();
    deps[guard] = () => false;
    assert.equal((await createYouzanPointsOperation(deps)(operation)).kind, "blocked");
    assert.equal(calls.length, 0);
  }
});

test("debit uses the L headquarters API, nested params and stable idempotency on every retry", async () => {
  const { calls, run } = setup();
  assert.deepEqual(await run(operation), { kind: "succeeded" });
  await run(operation);
  assert.match(calls[0].url, /youzan\.crm\.customer\.points\.decrease\/4\.0\.0/);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.params.user, { account_id: "trusted-member", account_type: 5 });
  assert.equal(body.params.points, 1);
  assert.equal(body.params.source_kdt_id, 456);
  assert.equal(body.params.is_do_ext_point, false);
  assert.equal(body.params.check_customer, true);
  assert.equal(body.params.biz_value, `boomer-points:${operation.id}`);
  assert.equal(body.params.biz_token, "debit");
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.ok(calls[0].init.signal);
});

test("refund reuses its own durable operation id, never the debit id", async () => {
  const { calls, run } = setup();
  const refund = { ...operation, id: "32328b54-619e-40f4-974c-514443d56d47", kind: "refund" as const };
  assert.deepEqual(await run(refund), { kind: "succeeded" });
  assert.match(calls[0].url, /points\.increase\/4\.0\.0/);
  assert.equal(JSON.parse(String(calls[0].init.body)).params.biz_token, "refund");
});

test("missing/ambiguous shop mapping and invalid input never dispatch", async () => {
  for (const changed of [{ points: 0 }, { points: -1 }, { points: 0.5 }, { points: 2147483648 },
    { id: "unstable" }, { yz_open_id: "" }, { source_kdt_id: 999 }, { kdt_id: 0 }, { kind: "sync" }]) {
    const { calls, run } = setup();
    assert.equal((await run({ ...operation, ...changed } as PointsOperation)).kind, "blocked");
    assert.equal(calls.length, 0);
  }
});

test("gateway success alone is never success; false, malformed and transport failure remain unknown", async () => {
  for (const response of [null, [], {}, { code: 200, success: true },
    { code: 200, success: true, data: { is_success: "false" } },
    { code: 200, success: true, data: { is_success: 1 } },
    { code: 500, success: false, message: "secret" },
    { code: 200, success: true, error_response: {}, data: { is_success: true } }]) {
    const { run } = setup(response);
    assert.deepEqual(await run(operation), { kind: "unknown", reason: "remote_result_unconfirmed" });
  }
  const { deps } = setup();
  deps.fetchImpl = async () => { throw Error("secret token customer phone"); };
  assert.deepEqual(await createYouzanPointsOperation(deps)(operation), { kind: "unknown", reason: "remote_result_unconfirmed" });
  deps.fetchImpl = async () => Response.json({ code: 200, success: true, data: { is_success: true } }, { status: 503 });
  assert.equal((await createYouzanPointsOperation(deps)(operation)).kind, "unknown");
});

test("boolean success is also accepted, auth/token errors never leak secrets", async () => {
  assert.deepEqual(await setup({ code: 200, success: true, data: { is_success: true } }).run(operation), { kind: "succeeded" });
  const { deps, calls } = setup();
  deps.resolveHeadquartersToken = async () => { throw Error("secret"); };
  assert.deepEqual(await createYouzanPointsOperation(deps)(operation), { kind: "blocked", reason: "headquarters_token_unavailable" });
  assert.equal(calls.length, 0);
});
test("provider duplicate code remains unconfirmed unless caller already has a successful operation", async () => {
  const {run} = setup({code:142100106,success:false,message:"duplicate"});
  assert.deepEqual(await run(operation), {kind:"unknown",reason:"remote_operation_duplicate"});
});

test("operation processing claims before dispatch and only returns success after fenced persistence", async () => {
  const events: string[] = [];
  const store = {
    claim: async (_id: string) => { events.push("claim"); return { ...operation, claim_token: "lease" }; },
    finish: async (id: string, token: string, result: { kind: string }) => {
      events.push("finish"); assert.equal(id, operation.id); assert.equal(token, "lease");
      assert.equal(result.kind, "succeeded"); return true;
    },
  };
  const result = await processPointsOperation(operation.id, store, async () => { events.push("dispatch"); return { kind: "succeeded" }; });
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(events, ["claim", "dispatch", "finish"]);
  store.finish = async () => false;
  assert.equal((await processPointsOperation(operation.id, store, setup().run)).kind, "unconfirmed");
  store.finish = async () => { throw Error("secret"); };
  assert.equal((await processPointsOperation(operation.id, store, setup().run)).kind, "unconfirmed");
});

test("no claim means no remote call; exception after dispatch is persisted as unknown", async () => {
  let writes = 0;
  const noClaim = { claim: async () => null, finish: async () => { writes++; return true; } };
  assert.equal((await processPointsOperation(operation.id, noClaim, async () => { writes++; return { kind: "succeeded" }; })).kind, "not_claimed");
  assert.equal(writes, 0);
  const store = { claim: async () => ({ ...operation, claim_token: "lease" }), finish: async (_id: string, _token: string, r: { kind: string }) => {
    assert.equal(r.kind, "unknown"); writes++; return true;
  } };
  assert.equal((await processPointsOperation(operation.id, store, async () => { throw Error("secret"); })).kind, "unknown");
  assert.equal(writes, 1);
});
