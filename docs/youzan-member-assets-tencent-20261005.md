# Youzan Member Assets: Tencent Verification

## Scope

ERP remains the member master and audit owner. This change receives points and buyer coupon notifications and records read-only external observations. It does not create an independently spendable points/coupon copy, enable redemption, issue coupons, or change wallets and ledgers.

## Implemented

- Raw-body Event-Sign validation with no fallback after a failed header signature. Legacy signatures remain blocked read-only hints, including after an operator requeues them. Separate authentication namespaces prevent a legacy hint suppressing a verified delivery.
- Durable inbox deduplication, conflicting-payload blocking, lease fencing, retry and manual requeue.
- Points queries use the active chain headquarters token, verified ERP/Youzan identity links, the fixed Tencent proxy, an explicit timeout, and exact account versions.
- Observation SQL rejects stale account versions, conflicting balances at the same version, and a changed customer owner. It never writes wallets, coupons or the points ledger.
- The bounded observer reads the existing SQLite identity map in read-only mode. Its host timer processes at most five inbox events per run; candidate servers do not start it.
- Coupon notifications retain separate take/consume/back/revert events. Automatic coupon observation stays blocked until a trusted voucher-code mapping and a supported authoritative query are connected.

## Verification Before Release

- 101 Youzan server/client/release tests passed, including the existing image integration tests.
- Ten PGlite SQL tests passed against migrations 0024-0031: deduplication, conflict, stale lease, requeue, role grants, RLS, exact large versions, same-version conflicts, late older responses and identity ownership conflicts.
- Tencent read-only probe: one existing mapped active ERP member successfully queried through the fixed proxy. Redemption policy and earning-rule endpoints responded successfully. No points, coupons or local wallets were changed.
- Full local `tsc --noEmit` is blocked by dependencies absent from the reused local node_modules: pinyin-pro, canvas-confetti and @electric-sql/pglite. Tencent's full type check also reports missing PGlite and an existing storefront-shops test type error. This is not a claim of a clean full-project type check. Tencent candidate build succeeded; the actual production points adapter also returned a valid exact-version observation in a read-only probe. Route probes must be checked separately.

## Release And Rollback

`prepare-youzan-assets-candidate.sh` copies the current production release and overlays only the member asset files. Dependencies are copied privately because Nitro mutates build metadata. It does not replace production until `release-youzan-assets.mjs` verifies the candidate on port 3006.

Release probes validate malformed bodies (400), invalid signatures (401), correctly signed invalid business events (422 without inbox writes), altered signed bodies (401), POS/OpenAPI (200), and the summary endpoint OPTIONS (204). The release script preserves existing worker flags, verifies port 3005 and the public domain, and rolls back to the previous release on failure.

The separate `boomer-youzan-asset-observer` timer is enabled only after the release. For rollback, stop/disable this new timer before restoring the previous app. Existing migrations are additive and contain no wallet/coupon mutations; do not drop audit tables during rollback.

## Still Required For Full Interoperability

- Real platform-delivered POINTS and buyer-coupon callbacks, including retry behavior and actual Event-Type header values. Synthetic signed HTTP probes are not proof of real subscription delivery.
- Trusted coupon ID-to-voucher-code mapping and a real supported query result. Coupon query-by-code is not a coupon-list or coupon-write API.
- Verified L-chain support and activation for cross-channel reservation, debit, cancellation and refund. General API approval and enabling Points Mall do not establish these contracts.
- A narrowly authorized canary covering debit, duplicate callbacks, payment failure, full/partial refunds, and coupon restore before enabling independent ERP redemption.

## Official Contracts

- [Raw-body push signature](https://doc.youzanyun.com/v2/doc/cloud/token/ZnS3wHtzOiuGNMkB31bcHr9jnUc.md)
- [Points query and L headquarters support](https://doc.youzanyun.com/v2/doc/cloud/token/SxGawlMSTiDAPkkRPM0cCtUKnky.md)
- [Buyer coupon query by voucher code](https://doc.youzanyun.com/v2/doc/cloud/token/VryPwHebmiDy4okZUk1czCDWnQf.md)

## Production Result

- Application commit `8b1c5f63bd58446977b84a464507156ab094b1fa` is on GitHub main and deployed at `/var/www/boomer-erp/releases/member-assets-8b1c5f6-20261005`.
- Candidate port 3006, production port 3005 and `https://erp.boomeroff.com` all passed the signed/invalid/malformed and existing-route probes above.
- PM2 application is online; the candidate is absent both live and in the saved restart state. Previous release is retained.
- `boomer-youzan-asset-observer.timer` is enabled/active. First service run exited 0 with no pending events and zero asset writes.
- Production rules re-read: free/monthly/annual plans all have redemption disabled, 100 points per 100 fen, cap rate 1. No enablement occurred during release.
- Inbox and observation tables both contained zero rows at final verification. Real platform message delivery and cross-channel debit/refund acceptance remain unverified. The release is not a declaration that full points/coupon interoperability is live.
- Independent review's three findings (candidate persistence, legacy-event suppression, changed snapshot ownership) were fixed and rechecked with 37 focused tests. Total final regression coverage: 101 server/client/release tests plus 10 SQL tests.
