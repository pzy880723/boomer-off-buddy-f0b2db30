import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const entry = new URL("./run-shortage-refunds.mjs", import.meta.url).href;
function run(enabled, token = "") {
  const env = { ...process.env, SHORTAGE_REFUND_WORKER_TOKEN: token };
  delete env.SHORTAGE_REFUND_WORKER_ENABLED;
  if (enabled !== undefined) env.SHORTAGE_REFUND_WORKER_ENABLED = enabled;
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    globalThis.fetch = () => { throw new Error('unexpected-payment-request'); };
    await import(${JSON.stringify(entry)});
  `], { env, encoding: "utf8" });
}

for (const enabled of [undefined, "false", "false "]) {
  test(`disabled shortage refund entry never requires credentials or contacts payment (${enabled})`, () => {
    const result = run(enabled);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, skipped: true, code: "refund_worker_disabled" });
  });
}

test("enabled shortage refund entry still fails closed without its token", () => {
  const result = run("true");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not configured/);
  assert.equal(result.stdout, "");
});

test("disabled worker with a token still cannot contact payment", () => {
  const token = "test-only-token-".repeat(3);
  const result = run("false", token);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  assert.equal(JSON.parse(result.stdout).skipped, true);
});
