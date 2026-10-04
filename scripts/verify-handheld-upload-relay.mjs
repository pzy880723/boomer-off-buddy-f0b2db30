// Run only on the trusted ERP server with its environment. Creates no products.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const base = process.argv[2];
assert.ok(base && /^(https:\/\/erp\.boomeroff\.com|http:\/\/127\.0\.0\.1:3006)$/.test(base));
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const {data:devices,error} = await db.from('inv_handheld_devices').select('token').eq('is_active',true).order('last_seen_at',{ascending:false}).limit(1);
assert.ifError(error); assert.ok(devices?.[0]?.token);
const bytes = await sharp(randomBytes(1024*1024*3),{raw:{width:1024,height:1024,channels:3}}).jpeg({quality:92}).toBuffer();
const digest = b => createHash('sha256').update(b).digest('hex');
const paths = [];
try {
  assert.equal((await fetch(`${base}/api/public/handheld/items/upload-image`,{method:'PUT',body:'invalid'})).status,403);
  for(let batch=0;batch<2;batch++) await Promise.all([0,1].map(async offset=>{
    const start=Date.now();
    const signed=await fetch(`${base}/api/public/handheld/items/upload-image`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Token':devices[0].token},body:JSON.stringify({bucket:'sku-raw',filename:'upload-verification.jpg',content_type:'image/jpeg',mode:'signed'}),signal:AbortSignal.timeout(20000)});
    assert.equal(signed.status,200);
    const envelope=await signed.json();assert.equal(envelope.ok,true);
    const data=envelope.data; paths.push(data.storage_path);
    assert.equal(new URL(data.upload_url).origin,base);
    assert.ok(data.headers['X-Upload-Token']); assert.equal(data.method,'PUT');
    const uploaded=await fetch(data.upload_url,{method:data.method,headers:data.headers,body:bytes,signal:AbortSignal.timeout(30000)});
    assert.equal(uploaded.status,200,`Upload ${batch*2+offset+1}`);
    const downloaded=await db.storage.from('sku-raw').download(data.storage_path);
    assert.ifError(downloaded.error);
    assert.equal(digest(Buffer.from(await downloaded.data.arrayBuffer())),digest(bytes));
    console.log(JSON.stringify({image:batch*2+offset+1,status:uploaded.status,bytes:bytes.length,exactOriginal:true,elapsed_ms:Date.now()-start}));
  }));
  console.log(JSON.stringify({verified:4,productsCreated:0,base}));
} finally {
  if(paths.length) {const result=await db.storage.from('sku-raw').remove(paths);assert.ifError(result.error);console.log(JSON.stringify({testObjectsRemoved:paths.length}));}
}
