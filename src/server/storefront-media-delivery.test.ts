import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {signStorefrontProductImages} from './storefront-products.server';

const listing:any={id:'a',sku_id:'s',title:'Cup',image_paths:['sku-listing/a.jpg'],cover_url:null,image_urls:[],price:10,product_type:'custom',location:null};
const product:any={id:'a',sku_id:'s',name:'Cup',image_url:null,image_urls:[],price:10,product_type:'custom',stock:1};
test('new list contract uses Tencent ready derivatives without signing any originals',async()=>{
 let calls=0;const key=createHash('sha256').update('sku-listing/a.jpg').digest('hex');
 const result=await signStorefrontProductImages([product],new Map([['a',listing]]),{
  thumbnail:true,originals:false,tencentManifest:{version:1,generatedAt:Date.now(),entries:{[key]:{digest:'a'.repeat(64)}}},
  signer:async()=>{calls++;throw Error('Should not request originals')},thumbnailSigner:async()=>{throw Error('Ready Tencent image must not sign legacy')},
 } as any);
 assert.equal(calls,0);assert.equal(result[0].image_url,null);assert.deepEqual(result[0].image_urls,[]);
 assert.match(result[0].thumbnail_url!,/\/640.jpg$/);assert.match((result[0] as any).preview_url,/\/1280.jpg$/);
});
test('missing Tencent derivatives use the safe thumbnail signer, not originals',async()=>{
 const result=await signStorefrontProductImages([product],new Map([['a',listing]]),{
  thumbnail:true,originals:false,tencentManifest:null,
  signer:async()=>{throw Error('No original')},thumbnailSigner:async paths=>paths.map(()=> 'https://safe.test/derivative'),
 } as any);
 assert.equal(result[0].thumbnail_url,'https://safe.test/derivative');assert.equal(result[0].image_url,null);
});
test('old clients retain the original-signature and thumbnail contract',async()=>{
 let calls=0;const result=await signStorefrontProductImages([product],new Map([['a',listing]]),{
  thumbnail:true,signer:async paths=>{calls++;return paths.map(()=> 'https://legacy.test/original')},thumbnailSigner:async paths=>paths.map(()=> 'https://legacy.test/thumb'),
 });
 assert.equal(calls,1);assert.equal(result[0].image_url,'https://legacy.test/original');assert.equal(result[0].thumbnail_url,'https://legacy.test/thumb');
});
