/** loadMeasurementActor：角色/门店权限读取出错必须受控失败，不得静默返回“无门店” */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const st: { fail: string | null; roles: string[]; perms: string[] } = { fail: null, roles: [], perms: [] };
(globalThis as any).__ma = st;

async function load() {
  const bundle = await build({
    entryPoints: ["src/server/measurement-actor.server.ts"],
    bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "s", setup(b: any) {
      b.onResolve({ filter: /^@\// }, (a: any) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `
        const q = (table) => ({ select: () => ({ eq: async () => {
          const s = globalThis.__ma;
          if (s.fail === table) return { data: null, error: { message: "boom" } };
          return { data: table === "user_roles" ? s.roles.map((role) => ({ role })) : s.perms.map((location_id) => ({ location_id })), error: null };
        } }) });
        export const supabaseAdmin = { from: q };` }));
    } }],
  });
  const dir = path.resolve("node_modules/.cache/measurement-http-test");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `actor-${process.pid}.mjs`);
  writeFileSync(file, bundle.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

test("权限读取正常：返回角色与门店", async () => {
  const m = await load();
  Object.assign(st, { fail: null, roles: ["store_staff"], perms: ["loc-a"] });
  assert.deepEqual((await m.loadMeasurementActor("u")).locationIds, ["loc-a"]);
});

test("角色或门店权限读取出错：抛受控错误 / try 版返回 null，不返回空门店", async () => {
  const m = await load();
  for (const table of ["user_roles", "user_location_perms"]) {
    Object.assign(st, { fail: table, roles: ["store_staff"], perms: ["loc-a"] });
    await assert.rejects(m.loadMeasurementActor("u"), /measurement_actor_unavailable/);
    assert.equal(await m.tryLoadMeasurementActor("u"), null);
  }
});
