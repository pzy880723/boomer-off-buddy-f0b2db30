import { currentProjectionFailure, evaluateOnboarding, type MappingCoverage } from './member-onboarding';
import { temporaryProjectionFailure, transientOnboardingError } from './member-onboarding-transient';
export type OnboardingJob = { shop_id: string; kdt_id: number; parent_kdt_id: number|null; revision: number; claim_token: string };
export type OnboardingWorkerDeps = {
  claim(shopId: string): Promise<OnboardingJob|null>;
  finish(job: OnboardingJob,status: string,reason: string,checks: Record<string,boolean|number|string>): Promise<boolean>;
  verifyProvider(job: OnboardingJob): Promise<{ ownership: boolean; tokensReadBack: boolean; rulesSupported: boolean; rulesEquivalent: boolean; hqPolicyScope?:string; hqPolicyFingerprint?:string; hqPolicyKdtId?:number; youzanPosInheritanceVerified?:boolean }>;
  mappings(job: OnboardingJob): Promise<MappingCoverage>;
  projections(job: OnboardingJob): Promise<Array<{ balance_synced_at: string|null; balance_failed_at: string|null; balance_failure?: string|null }>>;
  posSafe(): Promise<boolean>;
};
export async function runMemberOnboarding(shopId: string,d: OnboardingWorkerDeps) {
 const job=await d.claim(shopId); if (!job) return { status:'not_claimed' };
 try {
   const provider=await d.verifyProvider(job);
   const mapping=await d.mappings(job);
   const failedProjections=(await d.projections(job)).filter(r=>currentProjectionFailure(r.balance_synced_at,r.balance_failed_at));
   const currentFailures=failedProjections.length;
   const evidence={ ...provider,mapping,posSafe:await d.posSafe(),assetsEndToEnd:false };
   let result=evaluateOnboarding(evidence);
   if(provider.youzanPosInheritanceVerified!==true && result.status!=='blocked')result={status:'blocked',reason:'assets_not_end_to_end_verified'};
   if(result.status!=='blocked' && (provider.hqPolicyScope!=='youzan_chain_hq' || !/^[a-f0-9]{64}$/.test(provider.hqPolicyFingerprint??'') || provider.hqPolicyKdtId!==job.parent_kdt_id))result={status:'blocked',reason:'rule_semantics_unverified'};
   if(currentFailures>0 && result.status!=='blocked') result={status:'blocked',reason:'worker_unavailable'};
   const checks={...provider,youzanPosInheritanceVerified:provider.youzanPosInheritanceVerified===true,hqConfigurationMirrorVerified:provider.ownership&&provider.rulesSupported&&provider.rulesEquivalent,posSafe:evidence.posSafe,assetsEndToEnd:false,eligible:mapping.eligible,mapped:mapping.mapped,currentProjectionFailures:currentFailures,
     transientRetryEligible:result.reason==='worker_unavailable'&&currentFailures>0&&failedProjections.every(r=>temporaryProjectionFailure(r.balance_failure))};
   const accepted=await d.finish(job,result.status,result.reason,checks);
   return { status:accepted ? result.status : 'superseded',reason:result.reason,checks };
 } catch(error) {
   const accepted=await d.finish(job,'blocked','worker_unavailable',{transientRetryEligible:transientOnboardingError(error),youzanPosInheritanceVerified:false});
   return {status:accepted?'blocked':'superseded',reason:'worker_unavailable'};
 }
}