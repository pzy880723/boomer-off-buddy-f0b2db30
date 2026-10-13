import { createFileRoute } from "@tanstack/react-router";

// Private service-role relay for listing-image AI calls. No CORS headers: never callable from browsers.
// Upstream is fixed; only the three Google models used by retouching are accepted; the caller's
// Bearer is never forwarded. Bodies, prompts, images, URLs and keys are never logged or echoed.
const UPSTREAM = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODELS = new Set(["google/gemini-2.5-flash", "google/gemini-3.1-flash-image", "google/gemini-2.5-flash-image"]);
const MAX_BODY = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 125_000;
const NO_STORE = { "Cache-Control": "no-store" };

function deny(status: number, code: string) {
  return Response.json({ ok: false, code }, { status, headers: NO_STORE });
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const header = request.headers.get("authorization") ?? "";
  return key.length >= 20 && header.startsWith("Bearer ") && safeEqual(header.slice(7), key);
}

async function readLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

export const Route = createFileRoute("/api/public/hooks/listing-ai-relay")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorized(request)) return deny(401, "unauthorized");
        return Response.json({ ok: true, relay: "listing-ai", upstream: "fixed",
          models: [...MODELS], gateway_key: Boolean(process.env.LOVABLE_API_KEY) }, { headers: NO_STORE });
      },
      POST: async ({ request }) => {
        if (!authorized(request)) return deny(401, "unauthorized");
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return deny(415, "json_required");
        const gatewayKey = process.env.LOVABLE_API_KEY;
        if (!gatewayKey) return deny(503, "gateway_unconfigured");
        const text = await readLimited(request);
        if (text === null) return deny(413, "body_too_large");
        let parsed: { model?: unknown; stream?: unknown };
        try { parsed = JSON.parse(text); } catch { return deny(400, "invalid_json"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return deny(400, "invalid_json");
        if (typeof parsed.model !== "string" || !MODELS.has(parsed.model)) return deny(400, "model_not_allowed");
        if (parsed.stream === true) return deny(400, "stream_not_supported");
        const started = Date.now();
        let upstream: Response;
        try {
          upstream = await fetch(UPSTREAM, {
            method: "POST", redirect: "error",
            signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), request.signal]),
            headers: { Authorization: `Bearer ${gatewayKey}`, "Content-Type": "application/json", "X-Lovable-AIG-SDK": "fetch" },
            body: text,
          });
        } catch (error) {
          const name = (error as { name?: string })?.name;
          console.warn(JSON.stringify({ evt: "listing_ai_relay", model: parsed.model, ok: false, kind: name ?? "Error", ms: Date.now() - started }));
          return deny(name === "TimeoutError" ? 504 : 502, name === "TimeoutError" ? "upstream_timeout" : "upstream_unreachable");
        }
        console.info(JSON.stringify({ evt: "listing_ai_relay", model: parsed.model, status: upstream.status, ms: Date.now() - started }));
        const headers = new Headers(NO_STORE);
        headers.set("Content-Type", upstream.headers.get("content-type") ?? "application/json");
        for (const [k, v] of upstream.headers) if (k.toLowerCase().startsWith("x-lovable-aig-")) headers.set(k, v);
        return new Response(upstream.body, { status: upstream.status, headers });
      },
    },
  },
});
