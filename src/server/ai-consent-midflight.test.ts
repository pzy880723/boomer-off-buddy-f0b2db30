// Revocation between AI stages: the next outbound request must never be sent.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import {
  AI_POLICY_VERSION,
  beforeHandheldAiOutbound,
  handheldAiGuard,
  isAiConsentRevoked,
  type ConsentStore,
} from "./ai-guard.ts";
import { allowWebGuard } from "./ai-guard-fixtures.ts";

function toggleStore(initial: boolean) {
  const state = { allowed: initial, reads: 0, fail: false };
  const store: ConsentStore = {
    async get() { state.reads++; if (state.fail) throw new Error("db down"); return state.allowed; },
    async set() { return true; },
  };
  return { state, store };
}

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const stubs: Record<string, string> = {
  "@/integrations/supabase/client.server": "export const supabaseAdmin = {};",
  "@/server/product-recognition.server": "export const recognizeProductFromImages = () => {};",
  sharp: "export default () => ({ metadata: async () => ({ orientation: 1 }) });",
};
const bundle = await build({
  entryPoints: ["src/server/handheld-ai.server.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "stubs", setup(b: any) {
    b.onResolve({ filter: /.*/ }, (a: any) => (stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
});
const { aiPrepareListingImage } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function withFetch(onCall: (n: number, body: string) => Response, run: (calls: () => number) => Promise<void>) {
  const orig = globalThis.fetch;
  process.env.LOVABLE_API_KEY = "test-only";
  let n = 0;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => onCall(++n, String(init?.body ?? ""))) as typeof fetch;
  try { await run(() => n); } finally { globalThis.fetch = orig; }
}
const classifyOk = () => new Response(JSON.stringify({ choices: [{ message: { content:
  JSON.stringify({ measurement_tool: false, close_up: false, confidence: 1 }) } }] }));

describe("handheld guard re-reads consent on every check", () => {
  test("anonymous / wrong version / revoked / unreadable all fail closed", async () => {
    const { state, store } = toggleStore(true);
    await handheldAiGuard(store, { userId: "u1", policyVersion: AI_POLICY_VERSION }).check("a");
    await assert.rejects(handheldAiGuard(store, { userId: null, policyVersion: AI_POLICY_VERSION }).check("a"), isAiConsentRevoked);
    await assert.rejects(handheldAiGuard(store, { userId: "u1", policyVersion: "2026-01-01-v1" }).check("a"), isAiConsentRevoked);
    state.allowed = false;
    await assert.rejects(handheldAiGuard(store, { userId: "u1", policyVersion: AI_POLICY_VERSION }).check("a"),
      (e: any) => isAiConsentRevoked(e) && e.reason === "denied");
    state.fail = true;
    await assert.rejects(handheldAiGuard(store, { userId: "u1", policyVersion: AI_POLICY_VERSION }).check("a"),
      (e: any) => isAiConsentRevoked(e) && e.reason === "unavailable");
  });
  test("handheld-only modules reject web guards and missing guards", async () => {
    await assert.rejects(beforeHandheldAiOutbound(allowWebGuard, "x"), isAiConsentRevoked);
    await assert.rejects(beforeHandheldAiOutbound(undefined, "x"), isAiConsentRevoked);
  });
});

describe("listing image pipeline: revocation after a stage blocks the next AI request", () => {
  test("revoked after classification: generation and validation are never sent", async () => {
    const { state, store } = toggleStore(true);
    const guard = handheldAiGuard(store, { userId: "u1", policyVersion: AI_POLICY_VERSION });
    await withFetch((n) => { if (n === 1) { state.allowed = false; return classifyOk(); } throw new Error("must not send"); },
      async (calls) => {
        await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, guard), (e: any) => isAiConsentRevoked(e) && e.reason === "denied");
        assert.equal(calls(), 1);
      });
  });
  test("revoked after generation: output review is never sent", async () => {
    const { state, store } = toggleStore(true);
    const guard = handheldAiGuard(store, { userId: "u1", policyVersion: AI_POLICY_VERSION });
    await withFetch((n) => {
      if (n === 1) return classifyOk();
      if (n === 2) { state.allowed = false; return new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] })); }
      throw new Error("must not send");
    }, async (calls) => {
      await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, guard), isAiConsentRevoked);
      assert.equal(calls(), 2);
    });
  });
  test("web guard never reaches the handheld image pipeline", async () => {
    await withFetch(() => { throw new Error("must not send"); }, async (calls) => {
      await assert.rejects(aiPrepareListingImage({ image_base64: PNG }, allowWebGuard), isAiConsentRevoked);
      assert.equal(calls(), 0);
    });
  });
});

