import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = {
  calls: [],
  auth: { ok: false, response: new Response("no device", { status: 401 }) },
  session: null as null | { user_id: string },
  summaryResult: "粉嫩收纳盒，文具小物一盒收好。",
};
(globalThis as any).__summaryRoute = state;
const stubs: Record<string, string> = {
  "@tanstack/react-router": `export const createFileRoute = path => config => ({path,...config});`,
  "@/server/handheld-auth.server": `export const HANDHELD_CORS={"Access-Control-Allow-Origin":"*"};
    export const authenticateDevice=async()=>globalThis.__summaryRoute.auth;
    export const resolveSessionUser=async()=>globalThis.__summaryRoute.session;
    export const ok=(data)=>Response.json({ok:true,data});
    export const err=(message,status,extra)=>Response.json({ok:false,error:message,...extra},{status});`,
  "@/server/listing-summary.server": `import { z } from "zod";
    export const SummaryInput = z.object({ name: z.string().trim().min(1).max(120) }).strict();
    export const generateListingSummary=async(input)=>{ globalThis.__summaryRoute.calls.push(input);
      const r = globalThis.__summaryRoute.summaryResult;
      if (r instanceof Error) throw r;
      return r; };`,
};
const bundle = await build({
  entryPoints: ["src/routes/api/public/handheld/ai.generate-summary.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "stubs",
      setup(b: any) {
        b.onResolve({ filter: /.*/ }, (a: any) =>
          stubs[a.path] ? { path: a.path, namespace: "stub" } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({
          contents: stubs[a.path],
          loader: "js",
        }));
      },
    },
  ],
});
const { Route } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const post = (body?: unknown) =>
  new Request("http://local/ai/generate-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? { name: "收纳盒" }),
  });

test("缺设备认证 → 401，且不调用生成", async () => {
  assert.equal(Route.path, "/api/public/handheld/ai/generate-summary");
  const res = await Route.server.handlers.POST({ request: post() });
  assert.equal(res.status, 401);
  assert.deepEqual(state.calls, []);
});

test("有设备无员工会话 → 401 session_required", async () => {
  state.auth = { ok: true, device: { id: "d", location_id: "l" } };
  state.session = null;
  const res = await Route.server.handlers.POST({ request: post() });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "session_required");
  assert.deepEqual(state.calls, []);
});

test("有效输入 → ok 封装 data.description", async () => {
  state.session = { user_id: "u" };
  const res = await Route.server.handlers.POST({ request: post({ name: "  收纳盒  " }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.description, "粉嫩收纳盒，文具小物一盒收好。");
  assert.deepEqual(state.calls, [{ name: "收纳盒" }]);
});

test("空白 name → 422，不调用生成", async () => {
  state.calls = [];
  const res = await Route.server.handlers.POST({ request: post({ name: "   " }) });
  assert.equal(res.status, 422);
  assert.deepEqual(state.calls, []);
});

test("生成失败 → 503 简短中文，不泄漏细节", async () => {
  state.summaryResult = new Error("ai_http_error_500 with key xyz");
  const res = await Route.server.handlers.POST({ request: post() });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "简介生成失败，请稍后重试");
  assert.ok(!JSON.stringify(body).includes("xyz"));
  state.summaryResult = "粉嫩收纳盒，文具小物一盒收好。";
});

test("CORS 预检 204", async () => {
  const res = await Route.server.handlers.OPTIONS();
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});
