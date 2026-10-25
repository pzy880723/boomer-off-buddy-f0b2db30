import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recognizeProductTitle, PRODUCT_TITLE_PROMPT, PRODUCT_TITLE_MAX_TOKENS, PRODUCT_TITLE_TIMEOUT_MS, PRODUCT_TITLE_MAX_ATTEMPTS } from "./product-title.server";
import { allowHandheldGuard, allowWebGuard } from "./ai-guard-fixtures.ts";
import type { AiOutboundGuard } from "./ai-guard.ts";

const okBody = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: "google/gemini-3.8-flash", choices: [{ finish_reason: "stop", message: { content } }],
    usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 } }, ...extra }));

function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T | Error; lines: string[] }> {
  const lines: string[] = [];
  const info = console.info, warn = console.warn;
  console.info = (l: unknown) => { lines.push(String(l)); };
  console.warn = (l: unknown) => { lines.push(String(l)); };
  return fn().then((r) => ({ result: r as T | Error, lines }), (e) => ({ result: e as Error, lines }))
    .finally(() => { console.info = info; console.warn = warn; });
}

test("quick title uses one image, 1024 budget, low reasoning, unchanged model and prompt bytes", async () => {
  const prev = process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL;
  delete process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL;
  const name = await recognizeProductTitle("YWJj", allowHandheldGuard, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 1024);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.model, "google/gemini-2.5-flash");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.messages[0].content, PRODUCT_TITLE_PROMPT);
    assert.equal(body.messages[1].content.length, 1);
    assert.ok(init?.signal);
    return okBody('{"name":"蓝色复古随身听"}');
  }, "test-key");
  if (prev !== undefined) process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL = prev;
  assert.equal(name, "蓝色复古随身听");
  assert.equal(PRODUCT_TITLE_MAX_TOKENS, 1024);
  assert.equal(PRODUCT_TITLE_TIMEOUT_MS, 12_000);
  assert.equal(PRODUCT_TITLE_MAX_ATTEMPTS, 2);
  assert.equal(createHash("sha256").update(PRODUCT_TITLE_PROMPT).digest("hex"),
    "9d94c9dd38c6c0dc682884a6ea9675cb50b4212102cb9bf5f24125bedf8a2199");
});

test("configured model env is still honoured", async () => {
  process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL = "google/gemini-x-test";
  try {
    await recognizeProductTitle("YWJj", allowHandheldGuard, async (_u, init) => {
      assert.equal(JSON.parse(String(init?.body)).model, "google/gemini-x-test");
      return okBody('{"name":"白色马克杯"}');
    }, "test-key");
  } finally { delete process.env.HANDHELD_PRODUCT_RECOGNITION_MODEL; }
});

test("finish_reason=length with truncated content is a failure, never a half title, and not retried", async () => {
  let calls = 0;
  await assert.rejects(recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
    calls += 1;
    return okBody('{"name":"蓝色', { choices: [{ finish_reason: "length", native_finish_reason: "MAX_TOKENS", message: { content: '{"name":"蓝色' } }] });
  }, "test-key"), /AI title truncated/);
  assert.equal(calls, 1);
});

test("finish_reason=length rejects even when the content happens to parse", async () => {
  await assert.rejects(recognizeProductTitle("YWJj", allowHandheldGuard, async () =>
    okBody("", { choices: [{ finish_reason: "length", message: { content: '{"name":"蓝色随身听"}' } }] }), "test-key"), /AI title truncated/);
});

test("invalid title response does not become a product name", async () => {
  await assert.rejects(recognizeProductTitle("YWJj", allowHandheldGuard, async () => new Response('{"choices":[]}'), "test-key"));
});

test("a fast title without an evidence payload cannot claim rarity", async () => {
  const title = await recognizeProductTitle("YWJj", allowHandheldGuard, async () => okBody('{"name":"绝版收藏级蓝色随身听"}'), "test-key");
  assert.equal(title, "蓝色随身听");
});

test("503 is retried once (max 2 attempts); 401 is not retried", async () => {
  let n = 0;
  const t = await recognizeProductTitle("YWJj", allowHandheldGuard, async () => {
    n += 1; return n === 1 ? new Response("x", { status: 503 }) : okBody('{"name":"白色马克杯"}');
  }, "test-key");
  assert.equal(t, "白色马克杯"); assert.equal(n, 2);
  let m = 0;
  await assert.rejects(recognizeProductTitle("YWJj", allowHandheldGuard, async () => { m += 1; return new Response("x", { status: 401 }); }, "test-key"));
  assert.equal(m, 1);
  let k = 0;
  await assert.rejects(recognizeProductTitle("YWJj", allowHandheldGuard, async () => { k += 1; return new Response("x", { status: 503 }); }, "test-key"));
  assert.equal(k, 2);
});

test("consent revoked before the retry stops the second send; web guard rejected", async () => {
  let checks = 0, sends = 0;
  const guard: AiOutboundGuard = { kind: "handheld_staff", async check() { checks += 1; if (checks > 1) throw new Error("revoked"); } };
  await assert.rejects(recognizeProductTitle("YWJj", guard, async () => { sends += 1; return new Response("x", { status: 503 }); }, "test-key"), /revoked/);
  assert.equal(sends, 1);
  let webSends = 0;
  await assert.rejects(recognizeProductTitle("YWJj", allowWebGuard, async () => { webSends += 1; return okBody('{"name":"x"}'); }, "test-key"));
  assert.equal(webSends, 0);
});

test("logs carry only safe diagnostics: finish_reason enum, safe model, token ints, content length", async () => {
  const secret = "秘密标题内容";
  const { result, lines } = await captureLogs(() => recognizeProductTitle("SECRETIMG", allowHandheldGuard, async () =>
    okBody("", { model: "google/gemini-3.8-flash", choices: [{ finish_reason: "length", message: { content: `{"name":"${secret}` } }],
      usage: { completion_tokens: 249, completion_tokens_details: { reasoning_tokens: 241 } } }), "test-key"));
  assert.ok(result instanceof Error);
  const ev = JSON.parse(lines.at(-1)!);
  assert.equal(ev.outcome, "failed");
  assert.equal(ev.error_kind, "parse");
  assert.equal(ev.finish_reason, "length");
  assert.equal(ev.resolved_model, "google/gemini-3.8-flash");
  assert.equal(ev.completion_tokens, 249);
  assert.equal(ev.reasoning_tokens, 241);
  assert.equal(ev.content_length, secret.length + 9);
  const all = lines.join("\n");
  assert.ok(!all.includes(secret) && !all.includes("SECRETIMG") && !all.includes("test-key") && !all.includes("BOOMER"));
  // unsafe model names / unknown finish reasons are not echoed
  const r2 = await captureLogs(() => recognizeProductTitle("YWJj", allowHandheldGuard, async () =>
    okBody('{"name":"白色马克杯"}', { model: "evil\nname<script>", choices: [{ finish_reason: "weird_reason_x", message: { content: '{"name":"白色马克杯"}' } }] }), "test-key"));
  const ev2 = JSON.parse(r2.lines.at(-1)!);
  assert.equal(ev2.resolved_model, null);
  assert.equal(ev2.finish_reason, "other");
});
