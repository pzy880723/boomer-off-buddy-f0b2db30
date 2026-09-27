import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const script = new URL("./run-youzan-stock-worker.mjs", import.meta.url);
const source = existsSync(script) ? readFileSync(script, "utf8") : "";
const secret = "private-test-service-key";
async function run(env = { SUPABASE_SERVICE_ROLE_KEY: secret }, response = Response.json({ ok: true, data: { processed: 1, ok: 1, failed: 0 } }), error) {
  const calls = [], logs = [], timeouts = [], process = { env, exitCode: 0 };
  await vm.runInNewContext(`(async()=>{${source}\n})()`, {
    process, console: { log: s => logs.push(s), error: s => logs.push(s) },
    AbortSignal: { timeout: ms => { timeouts.push(ms); return AbortSignal.timeout(ms); } },
    fetch: async (url, init) => { calls.push({ url, init }); if (error) throw error; return response; },
  });
  assert.ok(!JSON.stringify(logs).includes(secret));
  return { calls, logs, timeouts, exit: process.exitCode };
}
test("runner posts one bounded service-role batch only to production loopback", async () => {
  const r = await run();
  assert.equal(r.exit, 0); assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "http://127.0.0.1:3005/api/public/hooks/youzan-stock-worker");
  assert.equal(r.calls[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(r.calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { limit: 1 });
  assert.deepEqual(r.timeouts, [590000]);
});
for (const env of [{}, { SUPABASE_PUBLISHABLE_KEY: secret }, { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: "3006" }, { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: "3005/evil" }]) {
  test(`runner rejects unsafe environment ${JSON.stringify(Object.keys(env))}`, async () => {
    const r = await run(env); assert.equal(r.exit, 1); assert.equal(r.calls.length, 0);
  });
}
test("runner reports partial failures on HTTP 200 without payload leakage", async () => {
  const r = await run(undefined, Response.json({ ok: true, message: secret, data: { processed: 1, ok: 0, failed: 1 } }));
  assert.equal(r.exit, 1); assert.equal(JSON.parse(r.logs[0]).code, "partial_failure");
});
for (const data of [{}, { processed: 1, failed: -1 }, { processed: 1, failed: "0" }, { processed: 2, failed: 0 }, { processed: 0, failed: 1 }, { processed: secret, failed: 0 }]) {
  test(`runner rejects malformed counts ${JSON.stringify(data)}`, async () => {
    assert.equal((await run(undefined, Response.json({ ok: true, data }))).exit, 1);
  });
}
test("runner handles idle, HTTP error, invalid JSON, and timeout safely", async () => {
  assert.equal((await run(undefined, Response.json({ ok: true, data: { processed: 0, failed: 0 } }))).exit, 0);
  assert.equal((await run(undefined, Response.json({ ok: false, code: secret }, { status: 500 }))).exit, 1);
  assert.equal((await run(undefined, new Response(secret))).exit, 1);
  assert.equal((await run(undefined, undefined, Error(secret))).exit, 1);
});
test("systemd uses protected current env, fixed production port and recurring oneshot", () => {
  const read = name => { const path = new URL(`../infra/tencent/${name}`, import.meta.url); return existsSync(path) ? readFileSync(path, "utf8") : ""; };
  const service = read("boomer-youzan-stock.service"), timer = read("boomer-youzan-stock.timer");
  assert.match(service, /Type=oneshot/); assert.match(service, /User=ubuntu/);
  assert.match(service, /EnvironmentFile=\/var\/www\/boomer-erp\/current\/\.env/);
  assert.match(service, /Environment=ERP_PORT=3005/);
  assert.match(service, /ExecStart=\/usr\/bin\/node .*\/scripts\/run-youzan-stock-worker.mjs/);
  assert.match(service, /TimeoutStartSec=600/); assert.match(service, /NoNewPrivileges=true/);
  assert.match(timer, /OnUnitInactiveSec=60s/); assert.match(timer, /Unit=boomer-youzan-stock.service/);
  const startup = readFileSync(new URL("./run-tencent-erp.sh", import.meta.url), "utf8");
  assert.match(startup, /STOCK_WORKER_OVERRIDE="\$\{YOUZAN_STOCK_WORKER_ENABLED-\}"/);
  assert.match(startup, /export YOUZAN_STOCK_WORKER_ENABLED="\$STOCK_WORKER_OVERRIDE"/);
  assert.match(startup, /if \[\[ "\$BIND_PORT" != 3005 \]\]; then[\s\S]*?export YOUZAN_STOCK_WORKER_ENABLED=false/);
});

test("Tencent startup defaults public media origin after loading env and preserves explicit override", () => {
  const startup = readFileSync(new URL("./run-tencent-erp.sh", import.meta.url), "utf8");
  assert.match(startup, /PUBLIC_ORIGIN_OVERRIDE="\$\{PUBLIC_APP_ORIGIN-\}"/);
  assert.match(startup, /export PUBLIC_APP_ORIGIN="\$\{PUBLIC_ORIGIN_OVERRIDE:-\$\{PUBLIC_APP_ORIGIN:-https:\/\/erp\.boomeroff\.com\}\}"/);
  assert.ok(startup.indexOf('source "$APP_DIR/.env"') < startup.indexOf("export PUBLIC_APP_ORIGIN="));
});

const bundle = await build({ entryPoints: ["src/routes/api/public/hooks/youzan-stock-worker.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "mock-boundaries", setup(b) {
    b.onResolve({ filter: /^@tanstack\/react-router$|^@\/lib\/youzan-sync.functions$/ }, a => ({ path: a.path, namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, a => ({ contents: a.path.startsWith("@tanstack")
      ? "export const createFileRoute=()=>x=>x;" : "export const runStockSyncWorkerForCron=async n=>globalThis.__stockHook(n);" }));
  } }] });
const { Route } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
test("hook denies public keys, requires explicit enable and production port, clamps batch and redacts errors", async () => {
  const env = { ...process.env };
  const calls = [];
  globalThis.__stockHook = async n => { calls.push(n); return { processed: 1, ok: 1, failed: 0 }; };
  const request = (headers = {}, body = {}) => Route.server.handlers.POST({ request: new Request("http://localhost/api/public/hooks/youzan-stock-worker", { method: "POST", headers, body: JSON.stringify(body) }) });
  const headers = { Authorization: `Bearer ${secret}` };
  try {
    process.env.SUPABASE_SERVICE_ROLE_KEY = secret; process.env.SUPABASE_PUBLISHABLE_KEY = "public";
    process.env.YOUZAN_STOCK_WORKER_ENABLED = "true"; process.env.PORT = "3005";
    assert.equal((await request({ apikey: "public" })).status, 401);
    delete process.env.YOUZAN_STOCK_WORKER_ENABLED;
    assert.equal((await request(headers)).status, 503);
    process.env.YOUZAN_STOCK_WORKER_ENABLED = "true"; process.env.PORT = "3006";
    assert.equal((await request(headers)).status, 503); assert.deepEqual(calls, []);
    process.env.PORT = "3005";
    assert.equal((await request(headers, { limit: "oops" })).status, 200); assert.equal(calls.at(-1), 1);
    await request(headers, { limit: 999 }); assert.equal(calls.at(-1), 3);
    globalThis.__stockHook = async () => ({ processed: 1, ok: 0, failed: 1 });
    assert.equal((await request(headers)).status, 500);
    globalThis.__stockHook = async () => { throw Error(secret); };
    const failure = await request(headers); assert.equal(failure.status, 500); assert.ok(!(await failure.text()).includes(secret));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); delete globalThis.__stockHook;
  }
});
