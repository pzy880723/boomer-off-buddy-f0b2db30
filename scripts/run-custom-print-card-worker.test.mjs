import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./run-custom-print-card-worker.mjs", import.meta.url), "utf8");
const secret = "fixture-only-private-key";
async function run({ env = { SUPABASE_SERVICE_ROLE_KEY: secret }, response, error } = {}) {
  const calls = [], logs = [];
  const process = { env, exitCode: 0 };
  await vm.runInNewContext(`(async()=>{${source}})()`, {
    process, AbortSignal,
    console: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (error) throw error;
      return response ?? Response.json({ ok: true, data: { claimed: 0, ready: 0, failed: 0, stale: 0 } });
    },
  });
  assert.ok(!JSON.stringify(logs).includes(secret));
  return { process, calls, logs };
}
test("idle worker calls only the independent loopback queue", async () => {
  const result = await run();
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.calls[0].url, "http://127.0.0.1:3005/api/public/hooks/custom-print-card-worker");
  assert.equal(result.calls[0].init.redirect, "error");
  assert.equal(result.calls[0].init.headers.Authorization, `Bearer ${secret}`);
});
test("no service key means no request", async () => {
  const result = await run({ env: {} });
  assert.equal(result.process.exitCode, 1);
  assert.equal(result.calls.length, 0);
});
test("unexpected response fields never enter logs", async () => {
  await run({ response: Response.json({ ok: true, data: { claimed: 0, ready: 0, failed: 0, stale: 0, secret } }) });
});
for (const data of [null, {}, { claimed: 2, ready: 2, failed: 0, stale: 0 }, { claimed: 0, ready: 1, failed: 0, stale: 0 }]) {
  test(`rejects invalid counts ${JSON.stringify(data)}`, async () => {
    const result = await run({ response: Response.json({ ok: true, data }) });
    assert.equal(result.process.exitCode, 1);
  });
}
test("network errors do not leak credentials", async () => {
  assert.equal((await run({ error: new Error(secret) })).process.exitCode, 1);
});
test("disabled worker is unsuccessful without logging response details", async () => {
  assert.equal((await run({ response: Response.json({ ok: false, message: secret }, { status: 503 }) })).process.exitCode, 1);
});
