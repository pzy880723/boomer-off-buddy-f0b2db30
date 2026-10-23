import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transientOnboardingError,temporaryProjectionFailure} from './member-onboarding-transient';
test('timeout and explicit temporary provider error retry; permissions and unknown do not',()=>{assert.equal(transientOnboardingError(new DOMException('timeout','TimeoutError')),true);assert.equal(transientOnboardingError(new Error('provider_temporarily_unavailable')),true);for(const code of ['no_permission','provider_read_rejected','token_expiry_unverified','cohort_read_failed','member_keyset_limit'])assert.equal(transientOnboardingError(new Error(code)),false);});
test('only current projection read unavailable reason is transient, never permission/mapping',()=>{assert.equal(temporaryProjectionFailure('youzan_read_unavailable'),true);for(const reason of ['shop_token_missing','youzan_query_rejected','identity_conflict',null])assert.equal(temporaryProjectionFailure(reason),false);});
