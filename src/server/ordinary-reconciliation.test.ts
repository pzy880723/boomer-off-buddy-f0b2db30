import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOrdinaryReconciliation } from './ordinary-reconciliation';
test('reconciles pending items independently and records attempted items for fair polling', async () => {
  const checked:string[]=[];const calls:string[]=[];
  const result=await runOrdinaryReconciliation({
    async list(){return [{id:'1',kind:'payment'},{id:'2',kind:'payment'},{id:'3',kind:'refund'}];},
    async reconcile(item:any){calls.push(item.id);if(item.id==='2')throw new Error('provider unavailable');},
    async markChecked(item:any){checked.push(item.id);},
  });
  assert.deepEqual(checked.sort(),['1','2','3']);assert.deepEqual(calls.sort(),['1','2','3']);
  assert.deepEqual(result,{attempted:3,succeeded:2,failed:1});
});
test('bounds concurrent provider calls and never runs more than 40 candidates',async()=>{
  let active=0,max=0,count=0;
  const result=await runOrdinaryReconciliation({async list(){return Array.from({length:100},(_,i)=>({id:String(i),kind:'payment'}));},
    async reconcile(){active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,2));active--;count++;},async markChecked(){} });
  assert.ok(max<=3);assert.equal(count,40);assert.equal(result.attempted,40);
});
