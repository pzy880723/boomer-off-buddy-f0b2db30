import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const media=await import('./storefront-tencent-media.server.ts').catch(()=>({}));
const key='sku-listing/a.png';const id=createHash('sha256').update(key).digest('hex');const digest='a'.repeat(64);
const manifest={version:1,generatedAt:100000,entries:{[id]:{digest}}};
test('Tencent contract resolves only prepared fixed derivatives, never arbitrary sources',()=>{
 assert.equal(typeof media.tencentDerivative,'function');
 const result=media.tencentDerivative(key,640,manifest);
 assert.equal(result,`https://erp.boomeroff.com/api/public/storefront/media/v1/${digest}/640.jpg`);
 assert.equal(media.tencentDerivative('https://sxddfcoiaboqcmeviykl.supabase.co/storage/v1/object/sign/'+key+'?token=new',1280,manifest),result.replace('/640.jpg','/1280.jpg'));
 for(const source of ['transfer-receipts/a.jpg','sku-listing/../a.png','https://evil.test/'+key,'sku-listing/missing.png'])assert.equal(media.tencentDerivative(source,640,manifest),null);
 assert.equal(media.tencentDerivative(key,0,manifest),null);assert.equal(media.tencentDerivative(key,1600,manifest),null);
 assert.equal(media.tencentDerivative(key,640,{...manifest,entries:{[id]:{digest:'../../bad'}}}),null);
});
test('manifest reader deduplicates concurrent reads and rejects invalid data',async()=>{
 assert.equal(typeof media.createManifestReader,'function');let calls=0;
 const reader=media.createManifestReader(async()=>{calls++;return new Response(JSON.stringify(manifest))},()=>100001);
 const [a,b]=await Promise.all([reader(),reader()]);assert.deepEqual(a,manifest);assert.deepEqual(b,manifest);assert.equal(calls,1);
 await reader();assert.equal(calls,1);
 for(const value of [{},{...manifest,generatedAt:999999999}, {...manifest,version:2}]){
  assert.equal(await media.createManifestReader(async()=>new Response(JSON.stringify(value)),()=>100001)(),null);
 }
});
