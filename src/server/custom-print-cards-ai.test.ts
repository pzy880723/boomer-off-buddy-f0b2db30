import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CardAiError, generateCardCopy, readCompletedOutput } from "./custom-print-cards-ai.server";
import { customCardMessage } from "./custom-print-cards-http.server";
import { allowHandheldGuard, allowWebGuard } from "./ai-guard-fixtures.ts";

const enc = new TextEncoder();
function sse(events: unknown[], opts: { hang?: boolean } = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      if (!opts.hang) c.close();
    },
    cancel() { cancelled = true; },
  });
  return { stream, wasCancelled: () => cancelled };
}
const delta = (d: string) => ({ type: "response.output_text.delta", delta: d });
const input = { topic: "卡通袜子", instructions: "", formats: ["portrait" as const], image: null };

describe("custom card AI stream", () => {
  test("parses only after response.completed", async () => {
    const s = sse([delta('{"title":"袜'), delta('子","headline":"好","body":"好"}'), { type: "response.completed" }]);
    const out = await readCompletedOutput(s.stream, new AbortController().signal);
    assert.equal(JSON.parse(out).title, "袜子");
  });
  test("response.incomplete and early close are failures, reader cancelled", async () => {
    const a = sse([delta("{}"), { type: "response.incomplete" }], { hang: true });
    await assert.rejects(readCompletedOutput(a.stream, new AbortController().signal), (e: CardAiError) => e.kind === "incomplete");
    assert.ok(a.wasCancelled());
    const b = sse([delta("{}")]);
    await assert.rejects(readCompletedOutput(b.stream, new AbortController().signal), (e: CardAiError) => e.kind === "incomplete");
  });
  test("output cap enforced", async () => {
    const s = sse([delta("x".repeat(17 * 1024))], { hang: true });
    await assert.rejects(readCompletedOutput(s.stream, new AbortController().signal), (e: CardAiError) => e.kind === "too_large");
    assert.ok(s.wasCancelled());
  });
  test("total deadline aborts a hanging stream and cancels it", async () => {
    const s = sse([delta("{")], { hang: true });
    const fetchImpl = (async () => new Response(s.stream, { status: 200 })) as unknown as typeof fetch;
    const t0 = Date.now();
    await assert.rejects(generateCardCopy({ guard: allowHandheldGuard, key: "k", input, fetchImpl, timeoutMs: 50 }), (e: CardAiError) => e.kind === "timeout");
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(s.wasCancelled());
  });
  test("deadline also covers a hanging fetch", async () => {
    const fetchImpl = ((_u: string, init: RequestInit) => new Promise((_, rej) =>
      init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await assert.rejects(generateCardCopy({ guard: allowHandheldGuard, key: "k", input, fetchImpl, timeoutMs: 30 }), (e: CardAiError) => e.kind === "timeout");
  });
  test("HTTP error reports status only", async () => {
    const fetchImpl = (async () => new Response("secret https://x?token=1", { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(generateCardCopy({ guard: allowHandheldGuard, key: "k", input, fetchImpl }), (e: Error) => e.message === "AI gateway 500");
  });
  test("chinese actionable messages per code", () => {
    assert.match(customCardMessage("version_conflict"), /退出编辑.*重新加载/);
    assert.match(customCardMessage("location_forbidden"), /库位/);
    assert.match(customCardMessage("validation_error"), /检查内容/);
    assert.match(customCardMessage("whatever"), /稍后/);
  });
});
