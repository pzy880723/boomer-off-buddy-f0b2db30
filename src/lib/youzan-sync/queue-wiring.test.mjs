import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { buildFixedWindows, classifySliceOutcome } from './cursor.ts';

const server = readFileSync(new URL('../../server/youzan-order-sync.server.ts', import.meta.url), 'utf8');
function worker({ result, claim, failCommit = false }) {
  const calls=[];
  let slice;
  const sb={
    from: () => ({ select: () => ({ eq: async () => ({data:[{id:'shop'}]}) }), upsert:async()=>({}) }),
    rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='youzan_claim_order_sync_cursor')return {data:[claim]};
      if(name==='youzan_commit_order_sync_batch')return failCommit?{error:{message:'lease_lost'}}:{data:['7:t1']};
      return {data:true};
    },
  };
  const code=server.slice(server.indexOf('/** 固定窗口登记')).replaceAll('export ','');
  const functions=vm.runInNewContext(`${stripTypeScriptTypes(code)}\n({enqueueOrderSyncWindows,runOrderSyncSliceOnce})`,{
    admin:async()=>sb,buildFixedWindows,classifySliceOutcome,Date,Math,Number,Error,Array,crypto,
    runOrdersSyncSlice:async(opts)=>{slice=opts;return result;},
  });
  return {...functions,calls,get slice(){return slice;}};
}
const claim={id:'cursor',shop_id:'shop',window_start:'2026-09-07T00:00:00Z',window_end:'2026-09-08T00:00:00Z',scan_end:'2026-09-07T10:00:00Z',next_page:1,attempts:0};
const result={ok:true,count:1,message:'ok',next_page:null,method_label:'v'};
test('enqueue uses atomic rearming RPC, not immutable insert-ignore',async()=>{
  const w=worker({claim,result});
  await w.enqueueOrderSyncWindows({days:3});
  assert.equal(w.calls[0]?.name,'youzan_enqueue_order_sync_windows');
});
test('worker uses fixed scan_end and fenced batch callback, never reports open scan as day done',async()=>{
  const w=worker({claim,result});
  const r=await w.runOrderSyncSliceOnce({workerId:'cron'});
  assert.equal(w.slice.end.toISOString(),'2026-09-07T10:00:00.000Z');
  assert.equal(typeof w.slice.commitRows,'function');
  await w.slice.commitRows([{tid:'t1'}]);
  const commit=w.calls.find(c=>c.name==='youzan_commit_order_sync_batch');
  assert.equal(commit.args.p_worker_id,w.calls[0].args.p_worker_id);
  assert.notEqual(commit.args.p_worker_id,'cron');
  assert.equal(r.done,false);
  assert.equal(r.scan_complete,true);
  assert.equal(r.status,'pending');
});

const cronSource=readFileSync(new URL('../../routes/api/public/hooks/youzan-sync.ts',import.meta.url),'utf8');
const authSource=readFileSync(new URL('../../server/youzan-sync-auth.server.ts',import.meta.url),'utf8');
function cron({error,slice={claimed:false}}={}){
  const env={SUPABASE_SERVICE_ROLE_KEY:'local-queue-fixture-service-key'};
  const requireYouzanSyncService=vm.runInNewContext(`${stripTypeScriptTypes(authSource.replace(/^import[^\n]*\n/gm,'').replaceAll('export ',''))}\nrequireYouzanSyncService`,{process:{env},Response});
  const code=cronSource.slice(cronSource.indexOf('// 定时同步')).replaceAll('export ','');
  const route=vm.runInNewContext(`${stripTypeScriptTypes(code)}\nRoute`,{
    createFileRoute:()=>o=>o,Response,URL,Date,JSON,console:{error(){}},crypto,process:{env},fetch:async()=>{},
    requireYouzanSyncService,dispatchYouzanSyncWorker:()=>{},
    supabaseAdmin:{from:()=>({select:()=>({eq:async()=>({data:[]})})})},
    enqueueOrderSyncWindows:async()=>{if(error)throw error;return {windows:0};},
    runOrderSyncSliceOnce:async()=>slice,
  });
  return route.server.handlers.POST({request:new Request('https://example.test/api/public/hooks/youzan-sync',{method:'POST',headers:{authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},body:'{}'})});
}
test('cron throws queue failure into non-success HTTP response',async()=>{
  const response=await cron({error:Error('db_failure')});
  assert.equal(response.status,500);
  assert.equal((await response.json()).ok,false);
});
test('cron exposes unsuccessful claimed slices as partial failure',async()=>{
  const response=await cron({slice:{claimed:true,applied:true,status:'error'}});
  assert.equal(response.status,207);
  assert.equal((await response.json()).ok,false);
});
