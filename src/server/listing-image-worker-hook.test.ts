import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state = {
  limits: [] as number[],
  result: { processed: 1 } as { processed: number; failed?: number },
};
(globalThis as any).__imageWorkerHook = state;
const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalEnabled = process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => config => config;",
  "@/server/handheld-listing-image-jobs.server": `export const runListingImageWorker=async limit=>{
    globalThis.__imageWorkerHook.limits.push(limit);return globalThis.__imageWorkerHook.result;};`,
};
const result = await build({
  entryPoints: ["src/routes/api/public/hooks/listing-image-worker.ts"],
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
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);
const post = (token = "test-service-key", body = {}) =>
  Route.server.handlers.POST({
    request: new Request("http://localhost/api/public/hooks/listing-image-worker", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  });
beforeEach(() => {
  state.limits = [];
  state.result = { processed: 1 };
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  delete process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
});
test("partial queue failure reports failure without dropping completed job counts", async () => {
  state.result = { processed: 1, failed: 1 };
  const response = await post();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: "worker_failed", data: state.result });
});
after(() => {
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  if (originalEnabled === undefined) delete process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
  else process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = originalEnabled;
});
for (const flag of ["false", "TRUE", "1"])
  test(`image hook refuses disabled/non-exact flag ${flag}`, async () => {
    process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = flag;
    const response = await post();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "worker_disabled");
    assert.deepEqual(state.limits, []);
  });
test("unset image worker flag preserves legacy enabled behavior", async () => {
  assert.equal((await post()).status, 200);
  assert.deepEqual(state.limits, [2]);
});
test("image hook checks authentication before reporting worker state", async () => {
  assert.equal((await post("wrong-key")).status, 401);
  process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = "true";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal((await post()).status, 401);
  assert.deepEqual(state.limits, []);
});
test("enabled authenticated image hook dispatches with bounded limit", async () => {
  process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = "true";
  assert.equal((await post("test-service-key", { limit: 99 })).status, 200);
  assert.deepEqual(state.limits, [6]);
});
for (const [limit, expected] of [
  ["oops", 2],
  ["4", 2],
  [null, 2],
  [2.9, 2],
  [-1, 1],
  [99, 6],
] as const)
  test(`hook sanitizes batch limit ${limit}`, async () => {
    assert.equal((await post("test-service-key", { limit })).status, 200);
    assert.deepEqual(state.limits, [expected]);
  });
test("Tencent startup forces image workers off on candidate ports after environment loading", () => {
  const script = readFileSync("scripts/run-tencent-erp.sh", "utf8");
  assert.match(
    script,
    /LISTING_IMAGE_WORKER_OVERRIDE="\$\{HANDHELD_LISTING_IMAGE_WORKER_ENABLED-\}"/,
  );
  assert.match(
    script,
    /if \[\[ "\$BIND_PORT" != 3005 \]\]; then[\s\S]*?HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false[\s\S]*?fi/,
  );
  assert.ok(
    script.indexOf('if [[ "$BIND_PORT" != 3005 ]]') > script.indexOf('source "$APP_DIR/.env"'),
  );
});
