// Tencent host only. No API route, no Cloud scheduler, no member-asset writes.
import { runMemberOnboarding } from '../src/server/member-onboarding-worker.server';
import { resolveTrustedYouzanMember } from '../src/server/youzan-points-projection-production.server';
import { youzanFetch } from '../src/lib/youzan-http';
import { inspectHqPointsPolicy, readHqDeductionPolicy } from '../src/server/hq-points-policy';
import { loadMemberOrganizations, hasVerifiedBranch } from '../src/server/member-organizations';

async function main() {
 const shopId=process.argv[2];
 if(!shopId || !/^[0-9a-f-]{36}$/i.test(shopId)) throw Error('explicit_shop_required');
 if(process.env.BOOMER_RUNTIME!=='tencent' || process.env.MEMBER_ONBOARDING_ENABLED!=='true' || !process.env.YOUZAN_PROXY_URL || !process.env.YOUZAN_PROXY_TOKEN) throw Error('tencent_fixed_proxy_required');
 const {supabaseAdmin:db}=await import('../src/integrations/supabase/client.server');
 // New functions are not in the generated types until the migration is applied.
 const rpc=db.rpc.bind(db) as unknown as (name:string,args:Record<string,unknown>)=>Promise<{data:any;error:any}>;
 const read=async(token:string,method:string,version:string,params:Record<string,unknown>={})=>{
   const body=JSON.stringify(params);
   const r=await youzanFetch(`https://open.youzanyun.com/api/${method}/${version}?access_token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(15000)});
   const j=await r.json() as {code?:number;success?:boolean;data?:unknown;response?:unknown};
   if(!r.ok || j.success===false || ![0,200].includes(Number(j.code))) throw Error('provider_read_rejected');
   return j.data??j.response;
 };
 const result=await runMemberOnboarding(shopId,{
   async claim(id){const r=await rpc('member_onboarding_claim',{p_shop_id:id});if(r.error)throw Error('claim_failed');return r.data;},
   async finish(j,status,reason,checks){const r=await rpc('member_onboarding_finish',{p_shop_id:j.shop_id,p_revision:j.revision,p_token:j.claim_token,p_status:status,p_reason:reason,p_checks:checks});if(r.error)throw Error('finish_failed');return r.data===true;},
   async verifyProvider(j){
     const {data:shops,error}=await db.from('youzan_shops').select('id,kdt_id,parent_kdt_id,role,status,access_token,token_expires_at').eq('status','active');
     if(error)throw Error('shops_read_failed');
     const head=shops?.filter(s=>s.role==='hq');const branch=shops?.find(s=>s.id===j.shop_id);
     if(head?.length!==1 || !branch || Number(head[0].kdt_id)!==Number(j.parent_kdt_id) || Number(branch.kdt_id)!==Number(j.kdt_id))return {ownership:false,tokensReadBack:false,rulesSupported:false,rulesEquivalent:false};
     // Reuse existing silent token contract; force renewal, conditional cache write and exact readback.
     const {fetchSilentToken}=await import('../src/lib/youzan.functions');
     const tokens:string[]=[];
     for(const shop of [head[0],branch]){
       const fresh=await fetchSilentToken(Number(shop.kdt_id));
       if(Date.parse(fresh.token_expires_at)<=Date.now()+300000)throw Error('token_expiry_unverified');
       const saved=await db.from('youzan_shops').update(fresh).eq('id',shop.id).eq('kdt_id',shop.kdt_id).eq('status','active').select('access_token,token_expires_at').single();
       if(saved.error || saved.data?.access_token!==fresh.access_token)throw Error('token_readback_failed');
       tokens.push(fresh.access_token);
     }
     const organizations=await loadMemberOrganizations(params=>read(tokens[0],'youzan.shop.chain.descendent.organization.list','1.0.1',params));
     const ownership=hasVerifiedBranch(organizations,Number(j.kdt_id),Number(j.parent_kdt_id));
     if(!ownership)return {ownership:false,tokensReadBack:true,rulesSupported:false,rulesEquivalent:false};
     // Chain branches are outside the official deduction getter scope. Never query branch zero or write rules.
     const policy=await inspectHqPointsPolicy(await readHqDeductionPolicy((method,version,params)=>read(tokens[0],method,version,params)),Number(j.parent_kdt_id),ownership);
     if(!policy.supported)return {ownership,tokensReadBack:true,rulesSupported:false,rulesEquivalent:false};
     return {ownership,tokensReadBack:true,rulesSupported:policy.supported,rulesEquivalent:policy.supported,
       hqPolicyScope:policy.scope,hqPolicyFingerprint:policy.fingerprint,hqPolicyKdtId:Number(j.parent_kdt_id),youzanPosInheritanceVerified:false};
   },
   async mappings(j){
     const counts={eligible:0,mapped:0,missing:0,conflict:0,unavailable:0};
     for(let offset=0;;offset+=100){
       const {data,error}=await db.from('commerce_customers').select('id').eq('status','active').order('id').range(offset,offset+99);
       if(error)throw Error('cohort_read_failed');
       for(const c of data??[]){counts.eligible++;const m=await resolveTrustedYouzanMember(c.id);if(m.kind==='found'&&Number(m.kdtId)===Number(j.parent_kdt_id))counts.mapped++;else if(m.kind==='conflict')counts.conflict++;else if(m.kind==='missing')counts.missing++;else counts.unavailable++;}
       if((data?.length??0)<100)break;
     }
     return counts;
   },
   async projections(j){
     const rows:Array<{balance_synced_at:string|null;balance_failed_at:string|null}>=[];
     for(let offset=0;;offset+=100){const r=await db.from('youzan_points_projection').select('balance_synced_at,balance_failed_at').eq('kdt_id',Number(j.parent_kdt_id)).order('customer_id').range(offset,offset+99);if(r.error)throw Error('projection_read_failed');rows.push(...r.data??[]);if((r.data?.length??0)<100)break;}return rows;
   },
   async posSafe(){
     const r=await db.from('commerce_membership_plans').select('id').eq('points_redemption_enabled',true).limit(1);if(r.error)throw Error('pos_policy_read_failed');
     // Current canonical POS quote/cash path still uses local wallet. Off switches alone cannot pass safety.
     return false;
   },
 });
 console.log(JSON.stringify({...result,assetWrites:0,ruleWrites:0,scope:'erp_registered_members_only'}));
}
main().catch(()=>{console.error(JSON.stringify({error:'member_onboarding_worker_failed',assetWrites:0,ruleWrites:0}));process.exitCode=1;});