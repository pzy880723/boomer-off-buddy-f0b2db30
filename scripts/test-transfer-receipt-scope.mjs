import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
let roles, allowed, writes;
const source = 'source', target = 'target';
const row = { id:'transfer', kind:'custom', status:'in_transit', qty:5, from_location_id:source, to_location_id:target, lines:[] };
const db = {
  from(table) {
    const data = table === 'user_location_perms' ? allowed.map(location_id=>({location_id})) : table === 'inv_locations' ? [source,target].map(id=>({id,name:id,is_active:true})) : table === 'stock_transfers' ? [row] : [];
    const q = { select(){return q}, eq(){return q}, order(){return q}, or(){return q}, range(){return q}, maybeSingle(){return Promise.resolve({data:data[0]})}, then(resolve,reject){return Promise.resolve({data}).then(resolve,reject)} };
    return q;
  },
  async rpc(){writes++;return {data:{status:'received'}}},
};
const compiled = await build({entryPoints:['src/server/custom-transfers.server.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['sharp','@/integrations/supabase/client.server','@/server/handheld-auth.server']});
const module={exports:{}};
vm.runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:(id)=>id==='@/integrations/supabase/client.server'?{supabaseAdmin:db}:id==='@/server/handheld-auth.server'?{loadUserRoles:async()=>roles}:require(id),console,Buffer,process,URL});
const {executeCustomTransfer:execute}=module.exports;
beforeEach(()=>{roles=['super_admin'];allowed=[];writes=0;});
test('HQ viewing outgoing transfer cannot receive at source',async()=>{
  const r=await execute('actor',{action:'detail',id:'transfer',location_id:source});
  assert.equal(r.transfer.can_receive,false);
  await assert.rejects(execute('actor',{action:'receive',id:'transfer',location_id:source,photo_ids:['photo']}),e=>e.code==='transfer_receive_forbidden');
  assert.equal(writes,0);
});
test('global view is read-only, not a receipt location',async()=>{
  assert.equal((await execute('actor',{action:'detail',id:'transfer'})).transfer.can_receive,false);
});
test('authorized destination can receive; HQ can receive incoming after switching',async()=>{
  assert.equal((await execute('actor',{action:'detail',id:'transfer',location_id:target})).transfer.can_receive,true);
  roles=['shop_manager'];allowed=[target];
  await execute('actor',{action:'receive',id:'transfer',location_id:target,photo_ids:['photo']});
  assert.equal(writes,1);
});
test('source user cannot forge destination context',async()=>{
  roles=['shop_manager'];allowed=[source];
  await assert.rejects(execute('actor',{action:'upload',id:'transfer',location_id:target,image_base64:'unused'}),e=>e.status===403);
  assert.equal(writes,0);
});
test('old handheld client uses its authenticated device location',async()=>{
  assert.equal((await execute('actor',{action:'detail',id:'transfer'},source)).transfer.can_receive,false);
  assert.equal((await execute('actor',{action:'detail',id:'transfer'},target)).transfer.can_receive,true);
});
