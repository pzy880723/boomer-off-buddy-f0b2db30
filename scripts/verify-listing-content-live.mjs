import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const base = process.argv[2] ?? 'http://127.0.0.1:3006';
const result = { base, stock_mutations: 0 };
const docResponse = await fetch(`${base}/api/public/handheld/openapi.json`);
assert.equal(docResponse.status, 200);
const doc = await docResponse.json();
for (const path of ['/api/public/handheld/items/{id}/content', '/api/public/handheld/ai/recognize-title']) {
  assert.ok(doc.paths[path]);
}
for (const path of ['items/00000000-0000-4000-8000-000000000000/content', 'ai/recognize-title']) {
  const response = await fetch(`${base}/api/public/handheld/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type'), /json/);
}
result.routes_and_anonymous_guard = true;
const taxonomy = await fetch(`${base}/api/public/storefront/taxonomy?content_release=20260927`).then(r => r.json());
assert.equal(taxonomy.ok, true);
assert.ok(taxonomy.data.facets.length >= 87);
assert.ok(taxonomy.data.facets.find(f => f.code === 'character_hello_kitty'));
const categories = new Set(taxonomy.data.primary_categories.flatMap(c => [c.code, ...c.children.map(x => x.code)]));
assert.ok(taxonomy.data.facets.every(f => f.category_codes.every(c => categories.has(c))));
result.facets = taxonomy.data.facets.length;

const db = createClient(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const admin = await db.from('user_roles').select('user_id').in('role', ['super_admin','hq_operator']).limit(1).single();
if (admin.error) throw admin.error;
const location = await db.from('inv_locations').select('id').eq('is_active', true).limit(1).single();
if (location.error) throw location.error;
const device = await db.from('inv_handheld_devices').select('id').limit(1).single();
if (device.error) throw device.error;
const sku = await db.from('inv_skus').select('id,image_paths').eq('status','active').eq('is_custom_price',true).eq('kind','single').limit(1).single();
if (sku.error) throw sku.error;
const snapshot = await db.rpc('handheld_product_content', {
  p_device_id: device.data.id, p_user_id: admin.data.user_id,
  p_location_id: location.data.id, p_sku_id: sku.data.id, p_request: { action:'get' },
});
if (snapshot.error) throw snapshot.error;
assert.ok(Number.isInteger(snapshot.data.version));
assert.ok(Array.isArray(snapshot.data.draft_blocks));
const denied = await db.rpc('handheld_product_content', {
  p_device_id: device.data.id, p_user_id:'00000000-0000-4000-8000-000000000000',
  p_location_id:location.data.id, p_sku_id:sku.data.id, p_request:{action:'get'},
});
assert.ok(denied.error);
result.content_read_and_scope = true;
const listings = await db.from('commerce_listings').select('id').eq('status','published').limit(5);
if (listings.error) throw listings.error;
result.public_detail = false;
for (const listing of listings.data) {
  const response = await fetch(`${base}/api/public/storefront/products/${listing.id}`);
  const body = await response.json();
  if (response.status === 200) {
    assert.ok(Array.isArray(body.data.detail_content));
    assert.equal(body.data.draft_blocks, undefined);
    result.public_detail = true;
    break;
  } else assert.equal(response.status,404);
}
const bytes = await sharp({ create:{width:16,height:8,channels:3,background:'#123456'} }).png().toBuffer();
assert.equal((await sharp(bytes).metadata()).width,16);
result.sharp = sharp.versions.sharp;

if (process.argv.includes('--ai-probe')) {
  const sample = await db.from('inv_skus').select('image_paths').eq('status','active').eq('is_custom_price',true)
    .not('image_paths','is',null).limit(20);
  if (sample.error) throw sample.error;
  const path = sample.data.flatMap(s => s.image_paths ?? []).find(p => /^sku-(raw|listing)\//.test(p));
  assert.ok(path, 'No product photo available for title timing');
  const slash=path.indexOf('/');
  const photo = await db.storage.from(path.slice(0,slash)).download(path.slice(slash+1));
  if (photo.error) throw photo.error;
  const preview = await sharp(Buffer.from(await photo.data.arrayBuffer())).resize(768,768,{fit:'inside',withoutEnlargement:true}).jpeg({quality:75}).toBuffer();
  const require=createRequire(import.meta.url);
  const { build }=createRequire(require.resolve('vite'))('esbuild');
  const compiled=await build({entryPoints:['src/server/product-title.server.ts'],bundle:true,write:false,platform:'node',format:'esm'});
  const { recognizeProductTitle }=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const started=Date.now();
  try {
    const title=await recognizeProductTitle(preview.toString('base64'));
    result.ai_title={ok:true,milliseconds:Date.now()-started,characters:title.length};
  } catch (error) {
    result.ai_title={ok:false,milliseconds:Date.now()-started,error:error.name};
  }
}
console.log(JSON.stringify(result));
