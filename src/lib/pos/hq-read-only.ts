import type {PointsRules} from './points-policy';
type Member = {kind:'found';customerId:string;kdtId:number;yzOpenId:string}|{kind:'missing'|'conflict'|'unavailable'};
type Row = {customer_id:string;kdt_id:number|null;yz_open_id:string|null;balance:number|null;balance_synced_at:string|null;balance_failed_at:string|null};
type Deps = {resolve:(id:string)=>Promise<Member>;read:(id:string)=>Promise<Row|null>;policy:(hq:number)=>Promise<unknown>};
export function assertNoPosPointsSpend(points:number) {
 if(points!==0)throw Error('pos_points_read_only');
}
/** HQ data are display evidence only, never a spendable local-wallet rule. */
export async function loadHqReadOnlyRules(customerId:string,deps:Deps):Promise<PointsRules> {
 let balance:number|null=null, hq:number|null=null, synced:string|null=null, fingerprint:string|null=null;
 let configuration=false;
 try {
  const m=await deps.resolve(customerId);
  if(m.kind==='found' && m.customerId===customerId) {
   hq=m.kdtId;
   const row=await deps.read(customerId);
   const s=Date.parse(row?.balance_synced_at??''),f=Date.parse(row?.balance_failed_at??'');
   if(row?.customer_id===customerId && row.kdt_id===hq && row.yz_open_id===m.yzOpenId && Number.isFinite(s) && (!Number.isFinite(f)||f<s) && row.balance!==null && Number.isSafeInteger(row.balance) && row.balance>=0) {balance=row.balance;synced=row.balance_synced_at;}
   const raw=await deps.policy(hq);
   if(raw && typeof raw==='object') {
    const c=raw as Record<string,unknown>;
    if(c.hqPolicyScope==='youzan_chain_hq' && c.hqPolicyKdtId===hq && c.hqConfigurationMirrorVerified===true && typeof c.hqPolicyFingerprint==='string' && /^[a-f0-9]{64}$/.test(c.hqPolicyFingerprint)) {configuration=true;fingerprint=c.hqPolicyFingerprint;}
   }
  }
 }catch { /* unavailable remains explicit; no fallback wallet or provider call */ }
 return {enabled:false,customer_active:false,available_points:null,cap_rate:0,points_per_unit:null,unit_fen:null,policy_version:null,
  hq_read_only:{source:'youzan',scope:'youzan_chain_hq',hq_kdt_id:hq,balance,last_synced_at:synced,configuration_mirror_verified:configuration,policy_fingerprint:fingerprint,assets_end_to_end:false,redemption_supported:false,reason:'pos_points_read_only'}};
}