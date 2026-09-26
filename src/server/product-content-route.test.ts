import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = {
  calls: [],
  auth: { ok: false, response: new Response(null, { status: 401 }) },
};
(globalThis as any).__productContentRoute = state;
const stubs: Record<string, string> = {
  "@tanstack/react-router": `export const createFileRoute = path => config => ({path,...config});`,
  "@/server/handheld-auth.server": `export const HANDHELD_CORS={"Access-Control-Allow-Origin":"*"};
    export const authenticateDevice=async()=>globalThis.__productContentRoute.auth;
    export const err=(message,status)=>new Response(message,{status});`,
  "@/server/product-content.server": `export const handleProductContent=async(...args)=>{globalThis.__productContentRoute.calls.push(args); return Response.json({ok:true});};`,
};
const bundle = await build({
  entryPoints: ["src/routes/api/public/handheld/items.$id.content.ts"],
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
test("content route authenticates the device before dispatch and preserves parameters", async () => {
  assert.equal(Route.path, "/api/public/handheld/items/$id/content");
  const request = new Request("http://local/content", { method: "POST" });
  const params = { id: "sku" };
  assert.equal((await Route.server.handlers.POST({ request, params })).status, 401);
  assert.deepEqual(state.calls, []);
  state.auth = { ok: true, device: { id: "device", location_id: "location" } };
  assert.equal((await Route.server.handlers.POST({ request, params })).status, 200);
  assert.deepEqual(state.calls, [[request, state.auth.device, params.id]]);
});
test("content route supports handheld CORS preflight", async () => {
  const response = await Route.server.handlers.OPTIONS();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});
