import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';

// Read-only production verification. Never creates a transfer or changes stock.
const base=process.argv[2]??'http://127.0.0.1:3006';
const response=await fetch(`${base}/api/public/handheld/custom-transfers`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'list'})});
assert.equal(response.status,401); assert.match(response.headers.get('content-type'),/json/);
const doc=await fetch(`${base}/api/public/handheld/openapi.json`).then(r=>r.json());
assert.ok(doc.paths['/api/public/handheld/custom-transfers']);
const file=(await readdir('.output/server/_ssr')).find(n=>/^custom-transfers\.server-.*\.mjs$/.test(n));
assert.ok(file);
const {executeCustomTransfer}=await import(pathToFileURL(resolve('.output/server/_ssr',file)));
const db=createClient(process.env.SUPABASE_URL??process.env.VITE_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const admin=await db.from('user_roles').select('user_id').in('role',['super_admin','hq_operator']).limit(1).single();
if(admin.error)throw admin.error;
const result=await executeCustomTransfer(admin.data.user_id,{action:'list',status:'all',q:'',page:1});
assert.equal(result.can_create,true);assert.ok(Array.isArray(result.items));assert.ok(result.locations.length>0);
const available=await executeCustomTransfer(admin.data.user_id,{action:'products',location_id:result.locations[0].id,q:'__codex_nonexistent__'});
assert.deepEqual(available.products,[]);
const none='00000000-0000-0000-0000-000000000000';
const restricted=await executeCustomTransfer(none,{action:'list',status:'all',q:'',page:1});
assert.equal(restricted.can_create,false);assert.deepEqual(restricted.items,[]);
await assert.rejects(executeCustomTransfer(none,{action:'create',client_op_id:'permission-probe',from_location_id:none,to_location_id:none,notes:'',lines:[]}),/只有管理员/);
console.log(JSON.stringify({anonymous_status:response.status,openapi:true,hq_list:true,scoped_permissions:true,product_rpc:true,transfers:result.items.length,locations:result.locations.length,stock_mutations:0}));
