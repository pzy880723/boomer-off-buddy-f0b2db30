import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
const source = await readFile(new URL("./run-youzan-image-refresh-worker.mjs", import.meta.url), "utf8");
async function run(env, body = { ok: true, data: { claimed: 2, failed: 0 } }, status = 200) {
  const calls = [], logs = [], process = { env, exitCode: 0 };
  const context = vm.createContext({ process, console: { log: x => logs.push(x), error: x => logs.push(x) },
    AbortSignal, fetch: async (url, options) => { calls.push({ url, options }); return { status, json: async () => body }; },
  });
  await vm.runInContext(`(async()=>{${source}})()`, context);
  assert.ok(!logs.join().includes("SECRET"));
  return { calls, process };
}
test("image runner calls only fixed production loopback with bounded service-role batch", async () => {
  const r = await run({ SUPABASE_SERVICE_ROLE_KEY: "SECRET", ERP_PORT: "3005" });
  assert.equal(r.process.exitCode, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "http://127.0.0.1:3005/api/public/hooks/youzan-image-refresh-worker");
  assert.equal(r.calls[0].options.headers.Authorization, "Bearer SECRET");
  assert.deepEqual(JSON.parse(r.calls[0].options.body), { limit: 2 });
});
test("image runner rejects missing credentials and candidate host", async () => {
  for (const env of [{}, { SUPABASE_SERVICE_ROLE_KEY: "SECRET", ERP_PORT: "3006" }]) {
    const r = await run(env);
    assert.equal(r.process.exitCode, 1); assert.equal(r.calls.length, 0);
  }
});
test("image runner treats partial or malformed success as failure", async () => {
  for (const body of [{ ok: true }, { ok: true, data: { claimed: 2, failed: 1 } }, { ok: true, data: { claimed: 9, failed: 0 } }]) {
    assert.equal((await run({ SUPABASE_SERVICE_ROLE_KEY: "SECRET" }, body)).process.exitCode, 1);
  }
});
