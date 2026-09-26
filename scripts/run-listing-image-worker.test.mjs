import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const script = new URL("./run-listing-image-worker.mjs", import.meta.url);
const source = existsSync(script) ? readFileSync(script, "utf8") : "";
const secret = "test-only-private-service-key";
async function run({
  env = { SUPABASE_SERVICE_ROLE_KEY: secret },
  response = Response.json({ ok: true, data: { processed: 4 } }),
  error,
} = {}) {
  const calls = [],
    logs = [],
    timeouts = [];
  const process = { env, exitCode: 0 };
  await vm.runInNewContext(`(async () => {${source}\n})()`, {
    process,
    AbortSignal: {
      timeout: (ms) => {
        timeouts.push(ms);
        return AbortSignal.timeout(ms);
      },
    },
    console: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (error) throw error;
      return response;
    },
  });
  assert.ok(!JSON.stringify(logs).includes(secret), "No credentials or raw errors may enter logs");
  return { process, calls, logs, timeouts };
}

for (const port of [undefined, "3005", "3006"])
  test(`posts a bounded batch to loopback ${port ?? "default"}`, async () => {
    const result = await run({ env: { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: port } });
    assert.equal(result.process.exitCode, 0);
    assert.equal(result.calls.length, 1);
    const { url, init } = result.calls[0];
    assert.equal(url, `http://127.0.0.1:${port ?? "3005"}/api/public/hooks/listing-image-worker`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    assert.deepEqual(JSON.parse(init.body), { limit: 2 });
    assert.equal(init.redirect, "error");
    assert.deepEqual(result.timeouts, [240000]);
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(result.logs[0]), {
      ok: true,
      status: 200,
      processed: 4,
      failed: 0,
      code: null,
    });
  });

for (const env of [
  {},
  { SUPABASE_PUBLISHABLE_KEY: secret },
  { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: "443" },
  { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: "3005/evil" },
]) {
  test(`rejects missing credential or unsupported port: ${Object.keys(env)}`, async () => {
    const result = await run({ env });
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.calls.length, 0);
  });
}

for (const [label, response] of [
  ["HTTP failure", Response.json({ ok: true, data: { processed: 1 } }, { status: 500 })],
  [
    "disabled candidate",
    Response.json({ ok: false, code: "worker_disabled", message: secret }, { status: 503 }),
  ],
  ["business failure", Response.json({ ok: false })],
  ["non-boolean ok", Response.json({ ok: "true", data: { processed: 1 } })],
  ["missing count", Response.json({ ok: true })],
  ["unsafe count", Response.json({ ok: true, data: { processed: secret } })],
  ["unbounded count", Response.json({ ok: true, data: { processed: 1000000000 } })],
  ["invalid JSON", new Response(`not JSON: ${secret}`)],
])
  test(`reports ${label} without leaking response contents`, async () => {
    assert.equal((await run({ response })).process.exitCode, 1);
  });

test("idle queue exits successfully", async () => {
  assert.equal(
    (await run({ response: Response.json({ ok: true, data: { processed: 0 } }) })).process.exitCode,
    0,
  );
});
for (const status of [200, 500])
  test(`partial failure exits nonzero and logs only safe counts on HTTP ${status}`, async () => {
    const result = await run({
      response: Response.json(
        { ok: status === 200, code: secret, message: secret, data: { processed: 1, failed: 2 } },
        { status },
      ),
    });
    assert.equal(result.process.exitCode, 1);
    assert.deepEqual(JSON.parse(result.logs[0]), {
      ok: false,
      status,
      processed: 1,
      failed: 2,
      code: "partial_failure",
    });
  });
for (const failed of [-1, 0.5, 13, "1", secret, null, false, {}])
  test(`rejects malformed failed count ${JSON.stringify(failed)}`, async () => {
    const result = await run({
      response: Response.json({ ok: true, data: { processed: 1, failed } }),
    });
    assert.equal(result.process.exitCode, 1);
    assert.deepEqual(JSON.parse(result.logs[0]), {
      ok: false,
      status: 200,
      processed: 1,
      failed: null,
      code: "unexpected_response",
    });
  });
test("explicit zero failures succeeds", async () => {
  const result = await run({
    response: Response.json({ ok: true, data: { processed: 1, failed: 0 } }),
  });
  assert.equal(result.process.exitCode, 0);
  assert.equal(JSON.parse(result.logs[0]).failed, 0);
});
test("server codes and extra payload are untrusted log data", async () => {
  const result = await run({
    response: Response.json({
      ok: false,
      code: secret,
      message: secret,
      data: { processed: secret },
    }),
  });
  assert.equal(result.process.exitCode, 1);
  assert.equal(JSON.parse(result.logs[0]).code, "unexpected_response");
});
test("timeout/network exceptions do not leak headers, source paths or signed URLs", async () => {
  const result = await run({
    error: new Error(`Authorization Bearer ${secret}; https://signed?token=${secret}`),
  });
  assert.equal(result.process.exitCode, 1);
  assert.equal(result.logs.length, 1);
});

test("systemd units use current release, protected env, bounded oneshot and recurring non-overlapping timer", () => {
  const servicePath = new URL("../infra/tencent/boomer-listing-image.service", import.meta.url);
  const timerPath = new URL("../infra/tencent/boomer-listing-image.timer", import.meta.url);
  const service = existsSync(servicePath) ? readFileSync(servicePath, "utf8") : "";
  const timer = existsSync(timerPath) ? readFileSync(timerPath, "utf8") : "";
  assert.match(service, /Type=oneshot/);
  assert.match(service, /User=ubuntu/);
  assert.match(service, /EnvironmentFile=\/var\/www\/boomer-erp\/current\/\.env/);
  assert.match(
    service,
    /ExecStart=\/usr\/bin\/node \/var\/www\/boomer-erp\/current\/scripts\/run-listing-image-worker\.mjs/,
  );
  assert.match(service, /TimeoutStartSec=250/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(timer, /OnBootSec=90/);
  assert.match(timer, /OnUnitInactiveSec=60s/);
  assert.match(timer, /Unit=boomer-listing-image\.service/);
  assert.match(timer, /WantedBy=timers.target/);
});
