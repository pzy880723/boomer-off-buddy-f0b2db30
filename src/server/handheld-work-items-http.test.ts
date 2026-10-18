import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {build}=createRequire(require.resolve('vite'))('esbuild');
const state={device:true,session:true,touched:false};(globalThis as any).__workItemsHTTP=state;
const stubs:Record<string,string>={
 '@tanstack/react-router':'export const createFileRoute=()=>o=>o;',
 '@/server/handheld-auth.server':`export const HANDHELD_CORS={};export const ok=d=>Response.json({ok:true,data:d});export const err=(e,status,detail)=>Response.json({error:e,...detail},{status});export const authenticateDevice=async()=>globalThis.__workItemsHTTP.device?{ok:true,device:{id:'d',location_id:'11111111-1111-4111-8111-111111111111'}}:{ok:false,response:new Response(null,{status:401})};export const resolveSessionUser=async()=>globalThis.__workItemsHTTP.session?{user_id:'u'}:null;`,
 '@/server/handheld-notifications.server':`export const resolveNotificationScope=async()=>({location_ids:['11111111-1111-4111-8111-111111111111']});export const applyRequestedLocation=(s,l)=>!l||s.location_ids.includes(l)?{ok:true,scope:s}:{ok:false,code:'location_forbidden'};`,
 '@/server/handheld-work-items.server':`export const loadWorkItems=async()=>{globalThis.__workItemsHTTP.touched=true;return {items:[],next_cursor:null,counts:{customers:2,internal:0,orders:0,system:0,total:2}};};`,
};
let handler:any;
async function getHandler(){if(handler)return handler;const out=await build({entryPoints:['src/routes/api/public/handheld/work-items.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'stubs',setup(b:any){b.onResolve({filter:/^@/},(a:any)=>stubs[a.path]?{path:a.path,namespace:'stub'}:undefined);b.onLoad({filter:/.*/,namespace:'stub'},(a:any)=>({contents:stubs[a.path]}));}}]});const m=await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);return handler=m.Route.server.handlers.GET;}
async function request(query=''){state.touched=false;return (await getHandler())({request:new Request('http://local/api/public/handheld/work-items'+query)});}
test('work-items missing device returns401 before data query',async()=>{state.device=false;state.session=true;const r=await request();assert.equal(r.status,401);assert.equal(state.touched,false);});
test('work-items missing employee session returns401 before query',async()=>{state.device=true;state.session=false;const r=await request();assert.equal(r.status,401);assert.equal(state.touched,false);});
test('work-items wrong store returns403 before pending query',async()=>{state.device=true;state.session=true;const r=await request('?location_id=22222222-2222-4222-8222-222222222222');assert.equal(r.status,403);assert.equal(state.touched,false);});
test('work-items rejects role/scope injection and bad cursor',async()=>{state.device=true;state.session=true;assert.equal((await request('?role=super_admin')).status,400);assert.equal((await request('?cursor=bad')).status,400);assert.equal(state.touched,false);});
test('work-items authorized query keeps full counts despite empty page',async()=>{state.device=true;state.session=true;const r=await request('?limit=1');assert.equal(r.status,200);const j=await r.json();assert.equal(j.data.counts.total,2);assert.deepEqual(j.data.items,[]);assert.equal(j.data.next_cursor,null);});
