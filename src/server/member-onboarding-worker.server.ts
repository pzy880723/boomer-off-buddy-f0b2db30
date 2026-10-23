import { currentProjectionFailure, evaluateOnboarding, type MappingCoverage } from './member-onboarding';
export type OnboardingJob = { shop_id: string; kdt_id: number; parent_kdt_id: number|null; revision: number; claim_token: string };
export type OnboardingWorkerDeps = {
  claim(shopId: string): Promise<OnboardingJob|null>;
  finish(job: OnboardingJob,status: string,reason: string,checks: Record<string,boolean|number>): Promise<boolean>;
  verifyProvider(job: OnboardingJob): Promise<{ ownership: boolean; tokensReadBack: boolean; rulesSupported: boolean; rulesEquivalent: boolean }>;
  mappings(job: OnboardingJob): Promise<MappingCoverage>;
  projections(job: OnboardingJob): Promise<Array<{ balance_synced_at: string|null; balance_failed_at: string|null }>>;
  posSafe(): Promise<boolean>;
};
export async function runMemberOnboarding(shopId: string,d: OnboardingWorkerDeps) {
 const job=await d.claim(shopId); if (!job) return { status:'not_claimed' };
 try {
   const provider=await d.verifyProvider(job);
   const mapping=await d.mappings(job);
   const currentFailures=(await d.projections(job)).filter(r=>currentProjectionFailure(r.balance_synced_at,r.balance_failed_at)).length;
   const evidence={ ...provider,mapping,posSafe:await d.posSafe(),assetsEndToEnd:false };
   let result=evaluateOnboarding(evidence);
   if(currentFailures>0 && result.status!=='blocked') result={status:'blocked',reason:'worker_unavailable'};
   const checks={...provider,posSafe:evidence.posSafe,assetsEndToEnd:false,eligible:mapping.eligible,mapped:mapping.mapped,currentProjectionFailures:currentFailures};
   const accepted=await d.finish(job,result.status,result.reason,checks);
   return { status:accepted ? result.status : 'superseded',reason:result.reason,checks };
 } catch {
   const accepted=await d.finish(job,'blocked','worker_unavailable',{});
   return {status:accepted?'blocked':'superseded',reason:'worker_unavailable'};
 }
}