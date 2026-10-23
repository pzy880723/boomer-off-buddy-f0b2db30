import {test,expect,mock} from 'bun:test';
let transactions=0,skuReads=0;
mock.module('@tanstack/react-router',()=>({createFileRoute:()=> options=>options}));
mock.module('@/integrations/supabase/client.server',()=>({supabaseAdmin:{
 from(table){if(table==='inv_skus')skuReads++;return {select:()=>({eq:()=>({maybeSingle:async()=>({data:{id:'shift',location_id:'store',operator_id:'operator'},error:null})})})};},
 async rpc(name,args){transactions++;return {data:{name,args},error:null};}
}}));
mock.module('@/server/pos-auth.server',()=>({POS_CORS:{},authenticatePosUser:async()=>({ok:true,user:{id:'operator'},roles:['store_staff']}),hasPosManagerRole:()=>false,posError:(message,status,code)=>Response.json({ok:false,message,code},{status}),posJson:(body,init)=>Response.json(body,init)}));
mock.module('@/lib/pos/points-policy.server',()=>({loadPointsRules:async()=>{throw Error('policy_must_not_run');}}));
const sales=await import('../../routes/api/public/pos/sales');
const preview=await import('../../routes/api/public/pos/discounts.preview');
const post=(route,body)=>route.server.handlers.POST({request:new Request('http://localhost/api',{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}})});
const id='11111111-1111-4111-8111-111111111111';
test('authorized positive preview refuses before SKU or policy reads',async()=>{const r=await post(preview.Route,{location_id:id,points_to_redeem:1,items:[{sku_id:id,quantity:1}]});expect(r.status).toBe(409);expect((await r.json()).code).toBe('pos_points_read_only');expect(skuReads).toBe(0);});
test('authorized positive cash sale refuses before transaction; zero preserves v2',async()=>{const body={shift_id:id,client_op_id:'test-operation',items:[{sku_id:id,quantity:1}],tenders:[{provider:'cash',amount:10}],points_to_redeem:1};const refused=await post(sales.Route,body);expect(refused.status).toBe(409);expect((await refused.json()).code).toBe('pos_points_read_only');expect(transactions).toBe(0);const zero=await post(sales.Route,{...body,points_to_redeem:0});expect(zero.status).toBe(201);const receipt=await zero.json();expect(receipt.data.name).toBe('pos_complete_sale_v2');expect(receipt.data.args.p_points_to_redeem).toBeUndefined();expect(transactions).toBe(1);});