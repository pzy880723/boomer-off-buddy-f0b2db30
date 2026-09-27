import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import sharp from 'sharp';

// Synthetic date labels only: no real customer photos, SKU writes, or audit inserts.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const compiled = await build({
  entryPoints: ['src/server/product-recognition.server.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm',
  external: ['./product-classification.server'],
});
const { runProductRecognition, callLovableProductModel, PRODUCT_RECOGNITION_PROMPT_VERSION } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

async function label(lines) {
  const rows = lines.map((text, i) => `<text x="40" y="${90 + i * 85}" font-size="42" font-family="sans-serif">${text}</text>`).join('');
  const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="450"><rect width="1000" height="450" fill="white"/><g fill="black">${rows}</g></svg>`)).png().toBuffer();
  return `data:image/png;base64,${image.toString('base64')}`;
}
const images = [
  await label(['HELLO KITTY - SANRIO', 'Copyright 1975, 2020 SANRIO', 'PRODUCT PACKAGING']),
  await label(['PRODUCT BACK LABEL', 'MFG 2020', 'MADE IN JAPAN']),
];
let audit;
const started = Date.now();
const result = await runProductRecognition({ images, source: 'handheld' }, {
  loadCategories: async () => [
    { id: 'root', code: 'toy', name: '玩具', parent_id: null, is_active: true },
    { id: 'leaf', code: 'toy_character_figure', name: '角色玩具', parent_id: 'root', is_active: true },
    { id: 'fallback', code: 'ai_low_confidence', name: '待归类', parent_id: 'root', is_active: true },
  ],
  callModel: callLovableProductModel,
  saveAudit: async value => { audit = value; return { id: 'synthetic-photo-year-probe' }; },
});
assert.equal(result.attributes.era, '2020年（生产年份）');
assert.ok(result.attributes.date_markings.some(mark => mark.image_index === 2 && mark.kind === 'manufacturing' && mark.years.includes(2020)));
assert.equal(audit.image_count, 2);
assert.equal(audit.prompt_version, PRODUCT_RECOGNITION_PROMPT_VERSION);
console.log(JSON.stringify({
  ok: true, prompt_version: PRODUCT_RECOGNITION_PROMPT_VERSION,
  era: result.attributes.era, date_markings: result.attributes.date_markings,
  milliseconds: Date.now() - started, synthetic_images: 2, database_writes: 0,
}));
