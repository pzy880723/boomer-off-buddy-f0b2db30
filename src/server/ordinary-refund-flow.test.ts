import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startOrdinaryRefund } from './ordinary-refund-flow';
function fixture() {
  const calls: string[] = [];
  const payment = { id:'p1', merchant_order_no:'order123', amount:'10.00', provider_transaction_id:'tx1',
    merchant_snapshot:{mode:'ordinary_wechat',merchant_id:'12345678',app_id:'wxmini'} };
  const refund = {id:'r1',payment_id:'p1',status:'processing',merchant_refund_no:'refund123',amount:'5.00',route_snapshot:payment.merchant_snapshot};
  const deps = { merchantId:'12345678',appId:'wxmini', store:{async rpc(name:string,args:any):Promise<any> {
    calls.push(name); if(name==='commerce_prepare_ordinary_refund') return {payment,refund,acquired:true,lease_token:'lease'};
    if(name==='commerce_apply_ordinary_refund') return {refund:{...refund,status:args.p_event.status}};
    return refund;
  }},client:{
    async queryRefund(_no:string):Promise<any>{calls.push('query');throw Object.assign(new Error('missing'),{code:'RESOURCE_NOT_EXISTS'});},
    async refund(input:any):Promise<any>{calls.push('refund');assert.equal(input.refundFen,500);assert.equal(input.refundNo,'refund123');return response;},
  }};
  const response = {out_refund_no:'refund123',out_trade_no:'order123',transaction_id:'tx1',refund_id:'wxrefund',status:'PROCESSING',amount:{total:1000,refund:500,currency:'CNY'}};
  const input={paymentId:'p1',afterSaleId:'sale1',idempotencyKey:'key',operatorId:'operator',roles:['hq_operator']};
  return {deps,input,calls,response,payment,refund};
}
test('only ERP headquarters can execute approved refund, not consumers or store staff',async()=>{
  for(const roles of [[],['store_staff'],['store_manager']]) {const f=fixture();await assert.rejects(startOrdinaryRefund(f.deps,{...f.input,roles}),/permission/i);assert.deepEqual(f.calls,[]);}
});
test('refund reserves approved amount first, queries stable refund number, then submits once',async()=>{
  const f=fixture();const result=await startOrdinaryRefund(f.deps,f.input);
  assert.deepEqual(f.calls,['commerce_prepare_ordinary_refund','query','refund','commerce_record_ordinary_refund']);
  assert.equal(result.status,'processing');assert.equal('route_snapshot' in result,false);
});
test('refund query timeout does not resubmit',async()=>{
  const f=fixture();f.deps.client.queryRefund=async()=>{throw new Error('timeout');};
  await assert.rejects(startOrdinaryRefund(f.deps,f.input),/timeout/);assert.deepEqual(f.calls,['commerce_prepare_ordinary_refund']);
});
test('already successful remote refund is applied without creating new refund',async()=>{
  const f=fixture();f.deps.client.queryRefund=async()=>({...f.response,status:'SUCCESS',success_time:'2026-09-08T01:00:00Z'});
  const result=await startOrdinaryRefund(f.deps,f.input);assert.equal(result.status,'succeeded');assert.equal(f.calls.includes('refund'),false);
});
test('refund response mismatch does not record or apply',async()=>{
  const f=fixture();f.deps.client.queryRefund=async()=>({...f.response,out_trade_no:'other'});
  await assert.rejects(startOrdinaryRefund(f.deps,f.input),/mismatch/);assert.deepEqual(f.calls,['commerce_prepare_ordinary_refund']);
});
