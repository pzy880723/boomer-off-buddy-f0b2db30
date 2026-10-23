import {test} from 'node:test';
import assert from 'node:assert/strict';
import {traverseMemberKeyset} from './member-keyset';
const ids=Array.from({length:101},(_,n)=>({id:String(n+1).padStart(5,'0')}));
for(const kind of ['customers','projections'])test(`${kind}: removal from first page cannot skip unmapped row 101`,async()=>{let active=[...ids];const seen:string[]=[];await traverseMemberKeyset({upperBound:async()=>ids[100].id,page:async(after,upper,limit)=>active.filter(r=>(after===null||r.id>after)&&r.id<=upper).slice(0,limit),key:r=>r.id,visit:async r=>{seen.push(r.id);if(r.id===ids[99].id)active=active.slice(1);}});assert.equal(seen.length,101);assert.equal(seen.at(-1),'00101');});
test('stable upper bound excludes later inserts without claiming a full live snapshot',async()=>{const seen:string[]=[];await traverseMemberKeyset({upperBound:async()=>ids[0].id,page:async()=>[ids[0]],key:r=>r.id,visit:async r=>{seen.push(r.id);}});assert.deepEqual(seen,['00001']);});
test('empty cohort makes no page request',async()=>{await traverseMemberKeyset({upperBound:async()=>null,page:async()=>{throw Error('unexpected_page');},key:(r:{id:string})=>r.id,visit:async()=>{}});});
test('non-progressing/duplicate/out-of-bound pages fail closed',async()=>{for(const rows of [[ids[1],ids[0]],[ids[0],ids[0]],[{id:'99999'}]])await assert.rejects(traverseMemberKeyset({upperBound:async()=>ids[100].id,page:async()=>rows,key:r=>r.id,visit:async()=>{}}),/keyset/);});
test('bounded traversal exhaustion throws rather than reports incomplete coverage',async()=>{await assert.rejects(traverseMemberKeyset({upperBound:async()=>ids[100].id,page:async(after,upper,limit)=>ids.filter(r=>(after===null||r.id>after)&&r.id<=upper).slice(0,limit),key:r=>r.id,visit:async()=>{}},1),/keyset_limit/);});
