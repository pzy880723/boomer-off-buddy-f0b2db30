# Youzan / ERP One-Point Integration Acceptance

Date: 2026-10-05. Scope: the original, uniquely mapped test member only.

## Authorization And Asset Boundaries

The user explicitly authorized a temporary one-point credit because the Youzan
test balance was zero, followed by debit, duplicate-request verification, refund,
and restoration to zero. ERP's existing 3000 points were not to change.
No other member, coupon issuance/redemption, real payment, or customer order was
authorized or exercised.

## Real Tencent Results

| Stage | Youzan Balance | ERP Balance | Result |
| --- | ---: | ---: | --- |
| Initial read | 0 | 3000 | Confirmed original mapping and baseline |
| Temporary seed | 1 | 3000 | `points.increase/4.0.0` succeeded |
| Debit | 0 | 3000 | `points.decrease/4.0.0` succeeded |
| Identical debit replay | 0 | 3000 | Provider rejected duplicate, code `142100106` |
| Refund of confirmed debit | 1 | 3000 | `points.increase/4.0.0` succeeded |
| Remove temporary credit | 0 | 3000 | `points.decrease/4.0.0` succeeded |
| Final read | 0 | 3000 | Baselines restored |

All writes traversed the existing Tencent fixed-egress proxy using the active
headquarters token. Original member and shop bindings were checked before dispatch.
Three durable SQL operations (debit, refund, cleanup debit) each finished
`succeeded`, with one claim attempt. The original ERP points ledger still contains
one row; the integration did not write local wallets or the points ledger.

The temporary seed's UUID and stage state were persisted before dispatch in a
root-only host state file. State writes fsync both file and parent directory.
Execution used an exclusive host lock. Completed stages do not send new mutations.
Verification always re-reads the remote balance, even on repeated invocation.

## Defects Found And Fixed

1. **Real int64 version parsing.** After adding points, Youzan returns an unquoted
   19-digit `points_account_version`. `Response.json()` rounded it and the safe
   validation then rejected the observation. The Node 22 JSON reviver now preserves
   the original primitive source as an exact decimal string. Invalid/fractional
   versions still fail closed. Regression tests use raw provider JSON bytes.
2. **Duplicate response semantics.** A repeated debit returns `142100106` and
   `success=false`, not another success envelope. The adapter identifies this but
   does not turn an originally unknown result into success. The canary accepts it
   only for the exact already-confirmed debit and separately verifies the balance.
3. **Identity and proxy safeguards.** A second conflicting identity added during
   database awaits now blocks dispatch. Malformed proxy configuration cannot fall
   through to a direct write.
4. **Notification setup guidance.** The panel now shows the Tencent callback and
   includes POINTS and COUPON_CUSTOMER_PROMOTION alongside the existing trade events.
   Received notifications are not labelled as successfully settled assets.

## Verification And Release

- 128 offline server, adapter, canary, and release tests passed.
- 18 PGlite SQL tests passed, including operation identity, duplicate keys,
  refund limits, lease fencing, and service-only execution.
- Tencent candidate build passed. Candidate, production loopback, and public
  routes passed malformed-body, signature, POS, OpenAPI, and summary-route checks.
- Application release: `member-assets-d6c8c6a-20261005`.
- Previous release retained: `member-assets-8b1c5f6-20261005`.
- Existing storefront server fixes were preserved by incremental overlay rather
  than overwriting production with the older full Git tree.
- An initial candidate extraction replaced the candidate's private `.env` symlink
  with the tracked public build environment. The prior private environment remained
  intact. The symlink was restored, observer execution verified successfully, and
  the prepare script now rejects archives containing environment files.
- Updated standalone observer/canary bundles were deployed after the real-test
  fixes. No new global spending worker or public mutation route was enabled.
- PM2 application is online; temporary candidate process is absent. Read-only
  observer service completed with `Result=success`, `ExecMainStatus=0`.

Full-project TypeScript checking is not claimed: pre-existing dependency and
storefront test typing problems were reported in the preceding release report.
PGlite tests are not evidence of real multi-session PostgreSQL concurrency.

## Not Yet Accepted As Complete

- Real POINTS/coupon notification delivery: inbox and observation counts remained
  zero after this test. Updating the ERP setup panel does not configure the Youzan
  developer console. Subscription and delivery must be verified there.
- General POS/online-order cross-channel redemption, payment-failure compensation,
  and partial refunds are not proven by this one-point test.
- Coupon claim discovery returned two activities and no claims in either activity.
  No real test coupon was issued or consumed; L-chain verify/refund extension
  activation and trusted coupon mapping remain unverified.
- Global remote writes remain disabled. The one-point allowlist was process-local
  and is not stored in PM2 or the application environment.

This report proves a narrowly scoped remote debit/refund/idempotency round trip,
not completion of all-member points, rules, and coupon interoperability.
