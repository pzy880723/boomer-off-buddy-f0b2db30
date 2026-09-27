import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Public model metadata only. This probe does not create, edit or publish a SKU.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const compiled = await build({
  entryPoints: ['src/server/product-era-research.server.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm',
});
const { researchProductRelease } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
const start = Date.now();
const blocks = await researchProductRelease({ name: 'Sony TPS-L2 cassette player', brand: 'Sony' });
assert.equal(blocks.length, 1, 'Official research returned no verified release evidence');
assert.equal(blocks[0].type, 'facts');
assert.match(blocks[0].text, /1979/);
assert.match(blocks[0].text, /sony\.com/);
assert.match(blocks[0].text, /不代表本件商品的生产年份/);
assert.doesNotMatch(blocks[0].text, /https?:\/\/|<|>/);
console.log(JSON.stringify({
  verified: true, milliseconds: Date.now() - start, stock_mutations: 0,
  published_mutations: 0, evidence: blocks[0].text,
}));
