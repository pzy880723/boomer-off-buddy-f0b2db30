import assert from 'node:assert/strict';
import {test} from 'node:test';
import sharp from 'sharp';
import {createImageReader, receiptPhotoURL, verifyReceiptPhotoURL} from '../src/server/erp-image-delivery.server.ts';
const path='11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg';
test('private receipt grants bind path, size and expiry; cannot access arbitrary objects',()=>{
 const url=new URL(receiptPhotoURL(path,480,'key','https://erp.example',100000));
 assert.deepEqual(verifyReceiptPhotoURL(url,'key',100001),{path,width:480});
 for(const [k,v] of [['path','other.jpg'],['width','1600'],['signature','fake'],['expires','999999999']]){
  const changed=new URL(url);changed.searchParams.set(k,v);assert.equal(verifyReceiptPhotoURL(changed,'key',100001),null);
 }
 assert.equal(verifyReceiptPhotoURL(url,'wrong',100001),null);
 assert.equal(verifyReceiptPhotoURL(url,'key',3700001),null);
 assert.throws(()=>receiptPhotoURL('../secret',480,'key','https://erp.example'));
});
test('real thumbnails are smaller; repeated/concurrent reads reuse cache; full stays full',async()=>{
 const original=await sharp({create:{width:1800,height:1200,channels:3,background:'#abc'}}).png().toBuffer();
 let reads=0;
 const read=createImageReader(async()=>{reads++;return original});
 const [a,b]=await Promise.all([read('transfer-receipts',path,480),read('transfer-receipts',path,480)]);
 assert.equal(reads,1);assert.deepEqual(a,b);
 assert.equal((await sharp(a).metadata()).width,480);
 await read('transfer-receipts',path,480);assert.equal(reads,1);
 const full=await read('transfer-receipts',path,1600);assert.equal((await sharp(full).metadata()).width,1600);
 assert.equal(reads,2);
 await assert.rejects(read('private','anything',480));
 await assert.rejects(read('sku-listing','../secret',480));
 await assert.rejects(read('sku-listing','a.png',99999));
});
test('failed downloads are not cached as a successful or permanently broken image',async()=>{
 let calls=0;const image=await sharp({create:{width:5,height:5,channels:3,background:'white'}}).png().toBuffer();
 const read=createImageReader(async()=>{if(++calls===1)throw Error('timeout');return image});
 await assert.rejects(read('sku-listing','test.png',480));
 assert.ok((await read('sku-listing','test.png',480)).length);assert.equal(calls,2);
});
