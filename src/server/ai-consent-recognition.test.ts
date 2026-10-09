// Recognition: revocation between model attempts must abort before the next request.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { AI_POLICY_VERSION, handheldAiGuard, isAiConsentRevoked, type ConsentStore } from "./ai-guard.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundled = await build({
  entryPoints: ["src/server/product-recognition.server.ts"],
  bundle: true, write: false, platform: "node", format: "esm",
});
const { runProductRecognition } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

function toggleStore(initial: boolean) {
  const state = { allowed: initial };
  const store: ConsentStore = { async get() { return state.allowed; }, async set() { return true; } };
  return { state, store };
}

describe("recognition: guard sits before every model attempt, never degrades to fallback", () => {
  const deps = (callModel: any) => ({
    loadCategories: async () => [{ id: "c", code: "toy", name: "玩具", parent_id: null, is_active: true, level: 1 },
      { id: "d", code: "toy_figure", name: "手办", parent_id: "c", is_active: true, level: 2 }] as any,
    callModel, saveAudit: async () => ({ id: "a" }), sleep: async () => {},
  });
  test("revoked during first failing attempt: retry is not sent", async () => {
    const { state, store } = toggleStore(true);
    let calls = 0;
    await assert.rejects(runProductRecognition(
      { aiGuard: handheldAiGuard(store, { userId: "u1", policyVersion: AI_POLICY_VERSION }), images: ["x"], source: "erp" },
      deps(async () => { calls++; state.allowed = false; throw new Error("AI gateway 500"); }),
    ), isAiConsentRevoked);
    assert.equal(calls, 1);
  });
});
