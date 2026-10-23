import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state: any = { fail: false, rows: [], ops: [] as string[] };
(globalThis as any).__ipc = state;
const admin = `export const supabaseAdmin={from(t){const s=globalThis.__ipc;const q={select(){s.ops.push('select:'+t);return q},eq(){return q},order(){return q},insert(){s.ops.push('insert:'+t);return q},update(){s.ops.push('update:'+t);return q},upsert(){s.ops.push('upsert:'+t);return q},then(res,rej){return Promise.resolve(s.fail?{data:null,error:{message:'down'}}:{data:s.rows,error:null}).then(res,rej)}};return q}};`;
const out = await build({ entryPoints: ["src/server/product-classification.server.ts"], bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "stubs", setup(b: any) {
    b.onResolve({ filter: /^@\/integrations\/supabase\/client\.server$/ }, () => ({ path: "admin", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: admin, loader: "js" }));
  } }] });
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

test("IP 库读取失败：返回原候选待核对，不关联、不写任何表", async () => {
  state.fail = true; state.ops = [];
  assert.deepEqual(await m.resolveIpCandidate(" 哆啦A梦 "), { id: null, name: "哆啦A梦", status: "review" });
  assert.ok(state.ops.every((o: string) => o.startsWith("select:")), state.ops.join());
});
test("命中已启用 IP 才关联；陌生候选待核对且不写表", async () => {
  state.fail = false; state.ops = [];
  state.rows = [{ id: "ip1", name: "哆啦A梦", name_original: null, aliases: [] }];
  assert.deepEqual(await m.resolveIpCandidate("哆啦A梦"), { id: "ip1", name: "哆啦A梦", status: "matched" });
  assert.deepEqual(await m.resolveIpCandidate("陌生IP"), { id: null, name: "陌生IP", status: "review" });
  assert.ok(state.ops.every((o: string) => o.startsWith("select:")));
});
