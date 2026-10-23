import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PointsRules } from "./points-policy";
import { loadHqReadOnlyRules } from './hq-read-only';

export async function loadPointsRules(customerId?: string | null): Promise<PointsRules | null> {
  if (!customerId) return null;
  const {resolveTrustedYouzanMember,productionProjectionStore}=await import('@/server/youzan-points-projection-production.server');
  return loadHqReadOnlyRules(customerId,{
    resolve:resolveTrustedYouzanMember,
    read:id=>productionProjectionStore.read(id),
    async policy(hq) {
      // Current identities/revisions only; a historical or other-HQ receipt cannot pass.
      const shops=await supabaseAdmin.from('youzan_shops').select('id,kdt_id,parent_kdt_id').eq('status','active').eq('role','branch').eq('parent_kdt_id',hq);
      if(shops.error)throw Error('hq_policy_unavailable');
      const rpc=supabaseAdmin.from.bind(supabaseAdmin) as unknown as (table:string)=>any;
      const jobs=await rpc('member_onboarding_jobs').select('shop_id,kdt_id,parent_kdt_id,checks').in('shop_id',(shops.data??[]).map(s=>s.id));
      if(jobs.error)throw Error('hq_policy_unavailable');
      const checks=(jobs.data??[]).filter((j:any)=>(shops.data??[]).some(s=>s.id===j.shop_id && Number(s.kdt_id)===Number(j.kdt_id) && Number(j.parent_kdt_id)===hq)).map((j:any)=>j.checks);
      const valid=checks.filter((c:any)=>c?.hqPolicyKdtId===hq && c.hqPolicyScope==='youzan_chain_hq' && c.hqConfigurationMirrorVerified===true && typeof c.hqPolicyFingerprint==='string' && /^[a-f0-9]{64}$/.test(c.hqPolicyFingerprint));
      return valid.length && new Set(valid.map((c:any)=>c.hqPolicyFingerprint)).size===1 ? valid[0] : null;
    },
  });
}
