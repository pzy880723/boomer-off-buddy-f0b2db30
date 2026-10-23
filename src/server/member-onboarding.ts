export type MappingCoverage = { eligible: number; mapped: number; missing: number; conflict: number; unavailable: number };
export type OnboardingEvidence = { ownership: boolean; tokensReadBack: boolean; mapping: MappingCoverage; rulesEquivalent: boolean; rulesSupported: boolean; posSafe: boolean; assetsEndToEnd: boolean };
export function evaluateOnboarding(e: OnboardingEvidence): { status: 'blocked'|'configuration_verified'|'verified'; reason: string } {
  if (!e.ownership) return { status: 'blocked', reason: 'hq_ownership_unverified' };
  if (!e.tokensReadBack) return { status: 'blocked', reason: 'token_unavailable' };
  if (!e.mapping.eligible || e.mapping.mapped !== e.mapping.eligible || e.mapping.missing || e.mapping.conflict || e.mapping.unavailable) return { status: 'blocked', reason: 'member_mapping_incomplete' };
  if (!e.rulesSupported || !e.rulesEquivalent) return { status: 'blocked', reason: 'rule_semantics_unverified' };
  if (!e.posSafe) return { status: 'blocked', reason: 'pos_local_wallet_path' };
  return e.assetsEndToEnd ? { status: 'verified', reason: 'ok' } : { status: 'configuration_verified', reason: 'assets_not_end_to_end_verified' };
}
export function currentProjectionFailure(success: string|null, failure: string|null) {
  if (!failure) return false;
  const f=Date.parse(failure), s=success ? Date.parse(success) : NaN;
  return !Number.isFinite(f) || !Number.isFinite(s) || f>=s;
}