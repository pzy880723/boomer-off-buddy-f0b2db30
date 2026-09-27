import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const state = {
  uploads: [] as any[], logs: [] as any[],
  response: { payload: { image_id: 42, image_url: "https://cdn.example.test/material.jpg" }, preview: "fixture" } as any,
  failure: null as Error | null,
};
(globalThis as any).__materialUploadTest = state;
const stubs: Record<string, string> = {
  "@tanstack/react-start": "export const createServerOnlyFn=f=>f; export const createServerFn=()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:f=>f};return c};",
  "@/integrations/supabase/client.server": `export const supabaseAdmin={from:table=>({insert:async row=>{
    if(table!=="youzan_sync_logs")throw Error("unexpected table"); globalThis.__materialUploadTest.logs.push(row);
  }})};`,
  "@/integrations/supabase/auth-middleware": "export const requireSupabaseAuth={};",
  "./youzan.functions": `export const callYouzanMultipartApiVerbose=async request=>{
    const s=globalThis.__materialUploadTest;s.uploads.push(request);if(s.failure)throw s.failure;return s.response;
  };
  const unexpected=()=>{throw Error("unexpected API call")};
  export const callYouzanApiVerbose=unexpected, callYouzanApiWithVersionFallback=unexpected,
    ensureAccessToken=unexpected, explainYouzanError=String, getHqShop=unexpected,
    pushYouzanQuantityUpdate=unexpected, runYouzanShopChainProbe=unexpected;`,
};
const bundle = await build({ entryPoints: ["src/lib/youzan-sync.functions.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["sharp"], plugins: [{ name: "offline-boundaries", setup(b: any) {
    b.onResolve({ filter: /.*/ }, (a: any) => stubs[a.path] ? { path: a.path, namespace: "stub" }
      : a.path.startsWith("@/") ? { path: resolve(a.path.replace(/^@\//, "src/") + ".ts") } : null);
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a: any) => ({ contents: stubs[a.path], loader: "js" }));
  }}] });
const module = { exports: {} as any };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
const { uploadImageToYouzanMaterialRecord, uploadImageToYouzanMaterial } = module.exports;
const sourceURL = "https://erp.example.test/sku-listing/ai.png";
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const limit = 3 * 1024 * 1024;

beforeEach(() => {
  state.uploads = []; state.logs = []; state.failure = null;
  state.response = { payload: { image_id: 42, image_url: "https://cdn.example.test/material.jpg" }, preview: "fixture" };
  globalThis.fetch = async () => { throw Error("unstubbed fetch is forbidden"); };
});
afterEach(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });

function source(bytes: Buffer, mime = "image/png") {
  globalThis.fetch = async () => new Response(new Uint8Array(bytes), { headers: { "content-type": mime } });
}

test("TanStack client compilation removes sharp and rejects image processing in the browser", async () => {
  const compilerRoot = new URL("./dist/esm/start-compiler/", pathToFileURL(require.resolve("@tanstack/start-plugin-core/package.json")));
  const { StartCompiler } = await import(new URL("compiler.js", compilerRoot).href);
  const { getLookupConfigurationsForEnv } = await import(new URL("config.js", compilerRoot).href);
  const compiler = new StartCompiler({
    env: "client", envName: "client", root: process.cwd(), framework: "react", providerEnvName: "ssr",
    mode: "build", lookupConfigurations: getLookupConfigurationsForEnv("client", "react"),
    lookupKinds: new Set(["ServerOnlyFn"]), getKnownServerFns: () => ({}),
    resolveId: async (id: string) => id, loadModule: async () => {},
  });
  const id = resolve("src/lib/youzan-material-image.server.ts");
  const code = await readFile(id, "utf8");
  const transformed = await compiler.compile({ id, code });
  const clientCode = transformed?.code ?? code;
  assert.doesNotMatch(clientCode, /["']sharp["']/);
  const clientBundle = await build({ stdin: { contents: clientCode, loader: "ts" }, write: false, platform: "browser", format: "cjs" });
  const clientModule = { exports: {} as any };
  new Function("module", "exports", clientBundle.outputFiles[0].text)(clientModule, clientModule.exports);
  assert.throws(() => clientModule.exports.prepareYouzanMaterialImage(new Uint8Array()), /server/i);
});
async function uploadedImage() {
  assert.equal(state.uploads.length, 1);
  const upload = state.uploads[0];
  assert.equal(upload.method, "youzan.materials.storage.platform.img.upload");
  assert.equal(upload.timeoutMs, 20_000);
  const file = upload.formData.get("image") as File;
  assert.equal(file.type, "image/jpeg");
  assert.match(file.name, /\.jpe?g$/i);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length < limit);
  assert.equal((await sharp(bytes).metadata()).format, "jpeg");
  return bytes;
}

test("oversize PNG becomes a bounded JPEG, keeps aspect and never modifies stored source bytes", async (t) => {
  const input = await sharp(randomBytes(2048 * 2048 * 3), { raw: { width: 2048, height: 2048, channels: 3 } }).png().toBuffer();
  assert.ok(input.length > limit);
  const digest = createHash("sha256").update(input).digest("hex");
  source(input);
  assert.deepEqual(await uploadImageToYouzanMaterialRecord("fixture", sourceURL), {
    imageId: 42, imageUrl: state.response.payload.image_url,
  });
  const image = await uploadedImage();
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 2048); assert.equal(metadata.height, 2048);
  assert.equal(createHash("sha256").update(input).digest("hex"), digest);
  const quality90 = await sharp(input).jpeg({ quality: 90 }).toBuffer();
  assert.ok(quality90.length >= limit, "Fixture must exercise a lower bounded quality, not just format conversion");
  const quality80 = await sharp(input).jpeg({ quality: 80 }).toBuffer();
  assert.deepEqual(image, quality80);
  t.diagnostic(`source PNG=${input.length} bytes; JPEG quality90=${quality90.length}; uploaded quality80=${image.length}`);
});

test("large dimensions below byte limit resize inside 2048 without cropping", async () => {
  const input = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "red" } }).png().toBuffer();
  assert.ok(input.length < limit); source(input);
  await uploadImageToYouzanMaterialRecord("fixture", sourceURL);
  const metadata = await sharp(await uploadedImage()).metadata();
  assert.equal(metadata.width, 2048); assert.equal(metadata.height, 1024);
});

test("transparent PNG becomes white opaque JPEG without upscaling", async () => {
  source(await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
  await uploadImageToYouzanMaterialRecord("fixture", sourceURL);
  const image = await uploadedImage();
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.width, 32); assert.equal(metadata.height, 24); assert.equal(metadata.hasAlpha, false);
  const pixel = await sharp(image).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([...pixel], [255, 255, 255]);
});

test("EXIF orientation is applied to pixels before metadata is removed", async () => {
  const input = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  source(input, "image/jpeg");
  await uploadImageToYouzanMaterialRecord("fixture", sourceURL);
  const metadata = await sharp(await uploadedImage()).metadata();
  assert.equal(metadata.width, 40); assert.equal(metadata.height, 80); assert.equal(metadata.orientation, undefined);
});

test("below-limit JPEG is still valid and is never enlarged", async () => {
  source(await sharp({ create: { width: 60, height: 40, channels: 3, background: "blue" } }).jpeg().toBuffer(), "image/jpeg");
  const url = await uploadImageToYouzanMaterial("fixture", sourceURL);
  assert.equal(url, state.response.payload.image_url);
  const metadata = await sharp(await uploadedImage()).metadata();
  assert.equal(metadata.width, 60); assert.equal(metadata.height, 40);
});

test("bad image bytes fail strictly without uploading or returning the original URL", async () => {
  source(Buffer.from("<html>upstream error</html>"));
  await assert.rejects(uploadImageToYouzanMaterial("fixture", sourceURL));
  assert.equal(state.uploads.length, 0); assert.equal(state.logs.length, 1);
});

test("source HTTP and empty-body failures never fall back to the raw URL", async () => {
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  await assert.rejects(uploadImageToYouzanMaterial("fixture", sourceURL), /HTTP 404/);
  source(Buffer.alloc(0));
  await assert.rejects(uploadImageToYouzanMaterial("fixture", sourceURL), /内容为空/);
  assert.equal(state.uploads.length, 0);
});

test("material upload failure propagates with no source URL fallback", async () => {
  source(await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer());
  state.failure = Error("fixture upload rejected");
  await assert.rejects(uploadImageToYouzanMaterial("fixture", sourceURL), /fixture upload rejected/);
  assert.equal(state.uploads.length, 1); assert.equal(state.logs.length, 1);
});

test("incomplete material response is not accepted as a source URL success", async () => {
  source(await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer());
  state.response = { payload: { image_url: "https://cdn.example.test/missing-id.jpg" }, preview: "missing id" };
  await assert.rejects(uploadImageToYouzanMaterial("fixture", sourceURL), /image_id/);
});

test("source download deadline covers reading the body and rejects without fallback", async () => {
  const controller = new AbortController();
  const deadlines: number[] = [];
  AbortSignal.timeout = (milliseconds: number) => { deadlines.push(milliseconds); return controller.signal; };
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    return { ok: true, arrayBuffer: async () => {
      controller.abort(new Error("fixture body deadline"));
      init?.signal?.throwIfAborted();
      return new ArrayBuffer(0);
    } } as Response;
  };
  await assert.rejects(uploadImageToYouzanMaterial("fixture", sourceURL), /fixture body deadline/);
  assert.deepEqual(deadlines, [20_000]); assert.equal(state.uploads.length, 0);
});
