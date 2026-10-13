// Handheld quick title + full recognition: short automatic names, relay transport, recognition_failed flag.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, describe, test } from "node:test";
import { normalizeAutoProductTitle, AUTO_PRODUCT_TITLE_MAX } from "../lib/product-title-text.ts";
import { recognizeProductTitle, PRODUCT_TITLE_PROMPT } from "./product-title.server.ts";
import { AiConsentRevokedError, type AiOutboundGuard } from "./ai-guard.ts";
import { LISTING_AI_RELAY_FIXED_URL, LISTING_AI_DIRECT_URL } from "./listing-ai-transport.server.ts";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundled = await build({ entryPoints: ["src/server/product-recognition.server.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const rec = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const allow: AiOutboundGuard = { kind: "handheld_staff", async check() {} };
const deny: AiOutboundGuard = { kind: "handheld_staff", async check(stage) { throw new AiConsentRevokedError("denied", stage); } };
const RELAY_ENV = { LISTING_AI_RELAY_URL: LISTING_AI_RELAY_FIXED_URL, SUPABASE_SERVICE_ROLE_KEY: "srk-0123456789abcdefghij" };
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...savedEnv }; });

describe("automatic title text helper", () => {
  test("caps at 24 Unicode characters deterministically, strips unsupported rarity", () => {
    assert.equal(AUTO_PRODUCT_TITLE_MAX, 24);
    const long = "Hello Kitty 粉色复古陶瓷马克杯带原盒附赠杯垫与小勺子礼盒套装完整";
    const out = normalizeAutoProductTitle(long);
    assert.ok(Array.from(out).length <= 24);
    assert.equal(out, normalizeAutoProductTitle(long));
    assert.equal(Array.from(normalizeAutoProductTitle("🐱".repeat(40))).length, 24);
    assert.equal(normalizeAutoProductTitle("绝版收藏级 蓝色随身听 稀有"), "蓝色随身听");
    assert.equal(normalizeAutoProductTitle("   "), "");
  });
});

describe("quick title", () => {
  test("prompt targets 12-20 chars, max 24, keeps evidence/rarity rules", () => {
    assert.match(PRODUCT_TITLE_PROMPT, /12.{0,3}20/);
    assert.match(PRODUCT_TITLE_PROMPT, /24/);
    assert.match(PRODUCT_TITLE_PROMPT, /禁止.*绝版/);
    assert.doesNotMatch(PRODUCT_TITLE_PROMPT, /40字/);
  });
  test("long model title is capped to 24", async () => {
    const t = await recognizeProductTitle("YWJj", allow, async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: "三丽鸥Hello Kitty粉色复古陶瓷马克杯带原装礼盒与杯垫完整套装" }) } }] })), "gw");
    assert.ok(Array.from(t).length <= 24);
  });
  test("default transport uses configured relay with service-role bearer, never the gateway key", async () => {
    Object.assign(process.env, RELAY_ENV);
    let seen: any;
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"蓝色随身听"}' } }] })); }) as any;
    assert.equal(await recognizeProductTitle("YWJj", allow, undefined, "gw-key"), "蓝色随身听");
    assert.equal(seen.url, LISTING_AI_RELAY_FIXED_URL);
    assert.equal((seen.init.headers as any).Authorization, `Bearer ${RELAY_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.ok(!JSON.stringify(seen.init.headers).includes("gw-key"));
    assert.equal(JSON.parse(seen.init.body).model, "google/gemini-2.5-flash");
    assert.ok(seen.init.signal);
  });
  test("denied consent sends nothing", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as any;
    await assert.rejects(recognizeProductTitle("YWJj", deny, undefined, "gw"), /ai_consent/);
    assert.equal(calls, 0);
  });
});

const cats = [{ id: "c", code: "toy", name: "玩具", parent_id: null, is_active: true, level: 1 },
  { id: "d", code: "toy_figure", name: "手办", parent_id: "c", is_active: true, level: 2 },
  { id: "s", code: "system", name: "系统", parent_id: null, is_active: true, level: 1 },
  { id: "l", code: "ai_low_confidence", name: "待人工确认", parent_id: "s", is_active: true, level: 2 }];
function deps(callModel: any, audits: any[] = []) {
  return { loadCategories: async () => cats as any, callModel, saveAudit: async (a: any) => { audits.push(a); return { id: "00000000-0000-4000-8000-000000000001" }; }, sleep: async () => {} };
}

describe("full recognition", () => {
  test("model failure: recognition_failed=true, fixed safe warning, raw error only in audit", async () => {
    const audits: any[] = [];
    const out = await rec.runProductRecognition({ aiGuard: allow, images: ["x"], source: "handheld" },
      deps(async () => { throw new Error("AI gateway 502: secret-upstream-detail key=sk-xyz"); }, audits));
    assert.equal(out.recognition_failed, true);
    assert.equal(out.name, "未命名中古商品");
    assert.ok(!String(out.warning).includes("secret-upstream"));
    assert.ok(!String(out.warning).includes("sk-xyz"));
    assert.match(JSON.stringify(audits[0].raw_result), /secret-upstream/);
  });
  test("low-confidence success is not a failure; long name capped before audit", async () => {
    const audits: any[] = [];
    const out = await rec.runProductRecognition({ aiGuard: allow, images: ["x"], source: "handheld" },
      deps(async () => ({ model: "m", raw: { category_code: "toy_figure", confidence: 0.2, name: "三丽鸥Hello Kitty粉色复古陶瓷马克杯带原装礼盒与杯垫完整套装" } }), audits));
    assert.equal(out.recognition_failed, false);
    assert.ok(Array.from(out.name).length <= 24);
    assert.equal(audits[0].normalized_result.name, out.name);
  });
  test("ERP source keeps names untruncated and recognition_failed=false on success", async () => {
    const long = "三丽鸥Hello Kitty粉色复古陶瓷马克杯带原装礼盒与杯垫完整套装";
    const out = await rec.runProductRecognition({ aiGuard: { kind: "web_erp", async check() {} }, images: ["x"], source: "erp" },
      deps(async () => ({ model: "m", raw: { category_code: "toy_figure", confidence: 0.9, name: long } })));
    assert.equal(out.recognition_failed, false);
    assert.equal(out.name, long);
  });
  test("handheld model call goes through relay; ERP call stays direct", async () => {
    Object.assign(process.env, RELAY_ENV, { LOVABLE_API_KEY: "gw-key" });
    const seen: any[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify({ choices: [{ message: { content: '{"category_code":"toy_figure","name":"x"}' } }] })); }) as any;
    const base = { images: ["data:image/jpeg;base64,YWJj"], taxonomyPrompt: "t", facetPrompt: "", brandPrompt: "", ipPrompt: "" };
    await rec.callLovableProductModel({ ...base, source: "handheld" });
    await rec.callLovableProductModel({ ...base, source: "erp" });
    assert.equal(seen[0].url, LISTING_AI_RELAY_FIXED_URL);
    assert.ok(!JSON.stringify(seen[0].init.headers).includes("gw-key"));
    assert.equal(seen[1].url, LISTING_AI_DIRECT_URL);
  });
  test("denied guard: no model call", async () => {
    let calls = 0;
    await assert.rejects(rec.runProductRecognition({ aiGuard: deny, images: ["x"], source: "handheld" }, deps(async () => { calls++; return {}; })), /ai_consent/);
    assert.equal(calls, 0);
  });
});

describe("title budget and naming rules (2026-10-13 follow-up)", () => {
  test("quick title uses a bounded 12s budget and makes exactly one request on failure", async () => {
    const t = await import("./product-title.server.ts");
    assert.equal(t.PRODUCT_TITLE_TIMEOUT_MS, 12_000);
    let calls = 0, signal: AbortSignal | undefined;
    await assert.rejects(t.recognizeProductTitle("YWJj", allow, async (_u, init) => { calls++; signal = init?.signal ?? undefined; return new Response("x", { status: 503 }); }, "gw"), /503/);
    assert.equal(calls, 1);
    assert.ok(signal && !signal.aborted);
  });
  test("quick + handheld full prompts: role/IP + shape/material + object, no aliases/descriptions/dates", () => {
    const full = rec.buildEraInstruction("handheld");
    for (const p of [PRODUCT_TITLE_PROMPT, full]) {
      assert.match(p, /Hello Kitty橘色挂件/);
      assert.match(p, /美乐蒂粉色抽拉包/);
      assert.match(p, /别名/);
      assert.match(p, /可爱/);
      assert.match(p, /简介/);
      assert.match(p, /12.{0,3}20/);
    }
    assert.doesNotMatch(rec.buildEraInstruction("erp"), /Hello Kitty橘色挂件/);
  });
});
