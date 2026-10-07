// 自定义卡片 AI 文案：Responses SSE。总时限覆盖 fetch + 读流；只认 response.completed；限制缓冲。
import { GENERATION_PROMPT, type CardFormat } from "@/server/custom-print-cards.server";

export const AI_TOTAL_TIMEOUT_MS = 90_000; // 必须低于数据库领取租约 180 秒
export const MAX_SSE_BUFFER = 256 * 1024;
export const MAX_OUTPUT = 16 * 1024;

export class CardAiError extends Error {
  constructor(public kind: "timeout" | "http" | "incomplete" | "too_large" | "format", message: string) { super(message); }
}

/** 解析 Responses SSE：仅在收到 response.completed 后返回累积的 output_text。 */
export async function readCompletedOutput(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "", completed = false, finished = false;
  const onAbort = () => { reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!completed) {
      if (signal.aborted) throw new CardAiError("timeout", "AI timeout");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new CardAiError("timeout", "AI timeout");
      if (done) { finished = true; break; }
      buf += dec.decode(value, { stream: true });
      if (buf.length > MAX_SSE_BUFFER) throw new CardAiError("too_large", "SSE buffer exceeded");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev: { type?: string; delta?: string };
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === "response.output_text.delta") {
          out += ev.delta ?? "";
          if (out.length > MAX_OUTPUT) throw new CardAiError("too_large", "output exceeded");
        } else if (ev.type === "response.completed") { completed = true; break; }
        else if (ev.type === "response.incomplete" || ev.type === "response.failed" || ev.type === "error") {
          throw new CardAiError("incomplete", `AI ${ev.type}`);
        }
      }
    }
    if (!completed) throw new CardAiError("incomplete", "AI stream ended before completion");
    return out;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function generateCardCopy(opts: {
  key: string;
  input: { topic: string; instructions: string; formats: CardFormat[]; image: { mime: string; b64: string } | null };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<unknown> {
  const { input } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? AI_TOTAL_TIMEOUT_MS);
  try {
    const text = `【主题】${input.topic}\n【补充说明】${input.instructions || "无"}\n【版式】${input.formats.join("/")}`;
    const content: unknown[] = [{ type: "input_text", text }];
    if (input.image) content.push({ type: "input_image", image_url: `data:${input.image.mime};base64,${input.image.b64}` });
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)("https://ai.gateway.lovable.dev/v1/responses", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${opts.key}`, "Lovable-API-Key": opts.key,
          "Content-Type": "application/json", "X-Lovable-AIG-SDK": "fetch",
        },
        body: JSON.stringify({
          model: "openai/gpt-6-astra",
          stream: true,
          store: false,
          reasoning: { effort: "low" },
          instructions: GENERATION_PROMPT,
          input: [{ role: "user", content }],
          text: { format: { type: "json_schema", name: "card_copy", strict: true, schema: {
            type: "object", additionalProperties: false, required: ["title", "headline", "body"],
            properties: { title: { type: "string" }, headline: { type: "string" }, body: { type: "string" } },
          } } },
        }),
      });
    } catch {
      throw ctrl.signal.aborted ? new CardAiError("timeout", "AI timeout") : new CardAiError("http", "AI gateway network");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new CardAiError("http", `AI gateway ${res.status}`);
    }
    const out = await readCompletedOutput(res.body, ctrl.signal);
    try { return JSON.parse(out); } catch { throw new CardAiError("format", "AI output not JSON"); }
  } finally {
    clearTimeout(timer);
  }
}
