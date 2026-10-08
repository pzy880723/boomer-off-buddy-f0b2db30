// Read-only cloud canary: local files in/out, no database or inventory writes.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const sourcePath = process.argv[2];
const outputDir = process.argv[3];
if (!sourcePath || !outputDir || !process.env.LOVABLE_API_KEY) throw Error('Missing fixture/output directory or gateway configuration');
await fs.mkdir(outputDir, { recursive: true });
const stubs = {
  '@/integrations/supabase/client.server': 'export const supabaseAdmin = {};',
  '@/server/product-recognition.server': 'export const recognizeProductFromImages = () => {};',
};
const bundled = await build({ entryPoints: ['src/server/handheld-ai.server.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['sharp'], plugins: [{ name: 'no-database', setup(b) {
    b.onResolve({ filter: /.*/ }, a => stubs[a.path] ? { path: a.path, namespace: 'stub' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: stubs[a.path], loader: 'js' }));
  } }] });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports);
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init) => {
  const request = JSON.parse(String(init?.body));
  const start = Date.now();
  const response = await originalFetch(url, init);
  const data = await response.clone().json();
  const record = { model: request.model, status: response.status, elapsedMs: Date.now() - start,
    finishReason: data.choices?.[0]?.finish_reason };
  if (request.model === 'google/gemini-3.1-flash-image') {
    const image = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (typeof image === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(image)) {
      const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      if (bytes.length > 20_000_000) throw Error('Canary output too large');
      await fs.writeFile(path.join(outputDir, 'generated-image'), bytes);
    }
  } else {
    try { record.check = JSON.parse(data.choices?.[0]?.message?.content ?? '{}'); } catch { record.invalidJson = true; }
  }
  requests.push(record);
  return response;
};
const start = Date.now();
let passed = false;
try {
  const input = await fs.readFile(sourcePath);
  const result = await module.exports.aiPrepareListingImage({ image_base64: input.toString('base64') });
  await fs.writeFile(path.join(outputDir, 'accepted.png'), Buffer.from(result.b64, 'base64'));
  passed = true;
} catch (error) {
  console.log(JSON.stringify({ passed: false, stage: error.stage, name: error.name }));
} finally {
  globalThis.fetch = originalFetch;
  const evidence = { passed, elapsedMs: Date.now() - start, requests, databaseWrites: false, inventoryWrites: false };
  await fs.writeFile(path.join(outputDir, 'probe.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
if (!passed) process.exitCode = 1;
