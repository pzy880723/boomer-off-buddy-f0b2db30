import { describe, it, expect } from 'vitest';
import { evaluateOnboarding, currentProjectionFailure } from './member-onboarding';

const valid = () => ({ ownership: true, tokensReadBack: true, mapping: { eligible: 10, mapped: 10, missing: 0, conflict: 0, unavailable: 0 }, rulesEquivalent: true, rulesSupported: true, posSafe: true, assetsEndToEnd: false });
describe('HQ-only onboarding gates', () => {
  it('configuration pass never claims asset acceptance', () => expect(evaluateOnboarding(valid())).toEqual({ status: 'configuration_verified', reason: 'assets_not_end_to_end_verified' }));
  it('missing ownership blocks', () => expect(evaluateOnboarding({ ...valid(), ownership: false }).status).toBe('blocked'));
  it('missing token permission blocks', () => expect(evaluateOnboarding({ ...valid(), tokensReadBack: false }).status).toBe('blocked'));
  it('unknown chain inheritance blocks', () => expect(evaluateOnboarding({ ...valid(), rulesEquivalent: false }).status).toBe('blocked'));
  it('unsupported rule contract blocks', () => expect(evaluateOnboarding({ ...valid(), rulesSupported: false }).status).toBe('blocked'));
  it('local wallet side path blocks', () => expect(evaluateOnboarding({ ...valid(), posSafe: false }).status).toBe('blocked'));
  it('missing identity blocks', () => expect(evaluateOnboarding({ ...valid(), mapping: { ...valid().mapping, mapped: 9, missing: 1 } }).status).toBe('blocked'));
  it('conflicting identity blocks', () => expect(evaluateOnboarding({ ...valid(), mapping: { ...valid().mapping, conflict: 1 } }).status).toBe('blocked'));
  it('empty cohort is not full coverage', () => expect(evaluateOnboarding({ ...valid(), mapping: { eligible: 0, mapped: 0, missing: 0, conflict: 0, unavailable: 0 } }).status).toBe('blocked'));
  it('historical failure after later success is not current failure', () => expect(currentProjectionFailure('2026-10-23T04:50:10Z', '2026-10-22T00:00:00Z')).toBe(false));
  it('newer failure is current', () => expect(currentProjectionFailure('2026-10-22T00:00:00Z', '2026-10-23T04:50:10Z')).toBe(true));
  it('failure without success remains current', () => expect(currentProjectionFailure(null, '2026-10-23T04:50:10Z')).toBe(true));
});