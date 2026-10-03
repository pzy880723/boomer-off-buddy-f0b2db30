# Unified POS and Points Redemption

## Latest Resumed Delivery

- Web application commit `0b09343` is on GitHub main and Tencent release
  `/var/www/boomer-erp/releases/pos-held-0b09343-20261003`. Public asset
  `index-BUDhLCJT.js` matches the candidate byte-for-byte. Previous release
  `pos-recovery-fc451ae-20261003` is retained. Both releases preserve the preceding
  mini-program release's storefront fixes.
- Web transport now treats malformed JSON envelopes and incomplete sale-success
  payloads as unknown. Neither first submission nor original-operation retry may
  discard the pending record without a confirmed order. 127 tests and TypeScript
  passed; candidate/public login hydration and worker guards passed.
- Held-cart resume now checks that its conditional update actually claimed a row.
  Two concurrent clients cannot both receive the same held cart: route regression
  verifies one 200 and one 409. This is not response-loss idempotent resume.
- Authenticated live Web checks at 390x844 and 1024x768 verified image/name groups,
  ascending price tiers including 12.9, cart selection/count/total, phone cart view,
  and the desktop central rail. The test cart was emptied; no sale was submitted.
- iPhone 16 Pro Max now has signed **1.1.27 (42)** installed and launched. No
  uninstall/reset occurred; parsed listing-draft data is unchanged. 77 focused
  tests passed. See the app workspace `ios/POS_DELIVERY_20261003_BUILD42.md`.
- Android now restores the original persisted cash payload/cart after restart,
  exposes server-confirmed recovery/cancellation, and implements native held-cart
  retrieval with stock/member/discount revalidation before claiming the hold.
  Final JVM tests: 193/193, including 83 POS tests. Debug APK built; no Android
  device is connected, so installation and physical acceptance remain unperformed.
  APK SHA-256: `e446dab1296ef20e602a6af9948aec3aeabf8e2bc22281cd29636c7c2ef0fe5d`.
  Independent incremental rebuild found a duplicate generated ` 2.dex` cache file;
  `:app:clean :app:testDebugUnitTest :app:assembleDebug` then passed in 28 seconds,
  all 44 tasks executed and XML reports confirm 193 tests with zero failures,
  errors or skips. The hash above is this clean-build deliverable.
  Native sources remain in the app workspace with the pre-edit backup; they are
  not part of this web repository's GitHub push.
- Migration `20261002174301` was installed through the connected Lovable database
  API as one transaction, with its migration-history record and schema-cache
  notification. Before installation POS HTTP routes briefly returned 503; all old
  Nginx requests drained and active POS DB transaction count was zero. The original
  Nginx configuration was restored unchanged in a finally block. No production
  payment, stock movement, refund, cancellation or wallet transaction was created.
- Production function definitions and trigger bodies were inspected and used in
  isolated real PostgreSQL testing: 16 passing tests, including observed concurrent
  lock waits, refund rounding, coupons and stock-sync-trigger rollback. API/permission
  tests passed 10/10. See `pos-points-postgres-audit-20261003.md`.
- Post-install verification confirms migration history, wrapper RPC signatures,
  service-only execute rights, revoked direct legacy-core execution, zero enabled
  plans and NULL conversion fields. The real PostgREST rules RPC returns HTTP 200
  with `enabled=false`. Existing free/explorer caps were not changed.
- This does not enable monetary redemption or verify physical payment/scanner/
  receipt hardware. An approved conversion rule is still required. Positive points
  remain cash-only; online payment restart recovery is not the durable cash guarantee.
- The latest membership review explicitly pauses rule writes. A read-only call to
  `youzan.scrm.pointdecution.get/1.0.0` succeeded for BOOMER headquarters
  `kdt_id=153242272`: plugin 5 value `0`, plugin 6 status `0`, no threshold or cap.
  Returned update time: `2026-10-03T04:51:45.268Z`. This current disabled rule does
  not establish what the historical intended rate was. No credentials or customer
  data were exported; no rule was written. Findings were sent directly to the
  coordinating membership task for the user's benefits review.

### Current Web Rollback

Only if current still resolves to `pos-held-0b09343-20261003`:

```sh
sudo env \
  POS_PREVIOUS_RELEASE=/var/www/boomer-erp/releases/pos-recovery-fc451ae-20261003 \
  POS_NEXT_RELEASE=/var/www/boomer-erp/releases/pos-held-0b09343-20261003 \
  POS_SOURCE_ARCHIVE=/tmp/boomer-pos-held-0b09343.tar.gz \
  bash /tmp/deploy-pos-20261003.sh rollback
```

This is an application rollback only. Keep the compatible DB wrappers and the
cancellation ledger; do not remove their late-request protection. Original function
definitions/ACLs, preflight, applied SQL envelope and post-install evidence are under
`tests/backend/pos-production-*-20261003.*`. Review any database reversal separately.

The sections below describe the earlier release checkpoint and its then-open gaps.

## Implemented

- Web and native Android/iOS use authenticated ERP standard groups, representative images and ascending actual SKU price tiers. No SKU IDs are generated from labels. The 12.9 tier is preserved.
- Standard/custom tabs, compact top search/member summary, quantity-sum cart count and compact cart rows. Desktop/tablet use a narrow central action rail. Phone uses a separate cart view and fixed quantity/amount dock.
- Custom browsing filters store stock before pagination, then checks reservation-aware availability. Pagination can continue through empty reserved pages. Store switches reject stale catalog responses.
- Web keyboard-wedge input is isolated from editable fields and dialogs. Native camera/payment paths and the existing app navigation remain in place.
- Discount contains server-quoted points redemption. Changing member/cart invalidates old discounts. Cash retries reuse the operation ID. Web held-cart restore reloads member benefits and re-quotes points.
- Points cash sale/debit/ledger and returns are transactional and idempotent. Return previews use cumulative per-line rounding and expose restored points. Zero-points sales remain compatible with the existing v2 backend.
- Web persists an unresolved sale before sending it. Reload retries the same payload and operation. Safe recovery returns the existing order or atomically cancels the original operation under the sale lock; a late cancelled request cannot create a sale. It never refunds money or clears a record on an uncertain response.
- Final review also fixed stale discount responses, invalid held-cart points, cross-store held-list responses, unsupported discount authorization and custom-search pagination drift.

## Verified Locally

- Web: 119 tests passed, zero failures; TypeScript passed; Tencent Node build passed.
- Browser checks use real production React components with intercepted in-memory API fixtures, not live sales: widths 360, 390, 1024 and 1440; no horizontal overflow; group covers loaded; 12.9 repeated twice gives 25.80; custom repeated twice stays one item; member/points quote, disabled rules and held-cart re-quote verified.
- Actual component fixtures also verified response-loss -> reload -> same-operation receipt recovery, uncommitted-sale cancellation -> reload without a pending lock, and a fresh held-cart quote preserving the member and points discount. Browser console errors: none. These cases never contact a real payment provider.
- Android: 162 JVM tests passed, zero failures/skips; Debug APK assembled. Includes 52 POS tests and account-bound persistent pending-cash protection.
- iOS: earlier full run 149 tests, 147 passed and two physical-camera skips; final POS/recovery run 54 tests passed and arm64 unsigned build passed. Native phone/tablet/points snapshots inspected. Exact cash payload and operation persist by account/location; recovery replays the original request or uses the server-confirmed cancellation endpoint.
- SQL tests use disposable PGlite with real legacy POS functions and a minimal schema. Inventory integrations are fixture stubs. These are not proof of real multi-connection PostgreSQL concurrency or hardware acceptance.

## Release Boundary

- Web deployed to Tencent on 2026-10-03. Native installation, live payment, production SQL and real scanner/printer/customer-display acceptance have not been performed.
- New migration: `20261002174301_pos_points_redemption.sql`. Rules default disabled/null. A membership policy owner must approve the point-to-money conversion and enable it after staging validation. Do not invent the conversion rate.
- Positive points currently support cash only. WeChat/Alipay endpoints reject points before contacting providers. No silent fallback that charges more than the quoted amount.
- Before enabling points: apply/review migration in staging, run true concurrent wallet/refund tests, verify actual location/catalog/receipt endpoints and physical devices, then use the Tencent candidate release and rollback workflow.
- Lovable's queue was explicitly paused by the user. It has not been resumed. Coordination messages do not mean migrations or deployments happened.
- Native Android take-held-order/returns were absent before this change; their action entries still direct staff to ERP. iOS retains its existing held workflow. Native optional subcategory editing was not added.
- Android pending-cash protection does not yet expose the new server-side recovery/cancellation UI or reconstruct a cart after restart; iOS does expose server-confirmed recovery. Unknown Android outcomes need ERP reconciliation before a replacement sale. No native real-payment/restart/hardware recovery acceptance is claimed.
- Native sources live in the separate local app workspace, currently untracked with no configured remote; they are not included in this ERP web/backend branch. Existing native files were backed up before editing.

## Earlier Tencent Release Evidence (2026-10-03)

- Application commit `b52dfb851c39dd25af5e73d744f99ba069d6bd0f` pushed to GitHub `main` without force.
- Release `/var/www/boomer-erp/releases/pos-unified-b52dfb8-20261003` copies the previous production release and overlays only this commit's changed files. Existing changed-file hashes matched the main baseline except generated routeTree, which was preserved and regenerated during the Linux build. No unrelated live hotfixes were replaced.
- Previous release `/var/www/boomer-erp/releases/product-sale-repair-20260927` retained. Rollback: run `sudo bash /tmp/deploy-pos-20261003.sh rollback` on the ERP server. Script source is `scripts/deploy-pos-20261003.sh` in this repository.
- Fresh 119 tests passed. Candidate Linux build passed. Candidate worker guards rejected execution; public guards rejected unauthenticated requests. Existing host worker configuration checksum unchanged. No SQL applied, no new timers installed.
- Public login hydration passed. Public `/assets/index-ByNbWEtH.js` exactly matches the candidate output containing the new POS. Existing hashed browser assets were retained for already-open sessions.
- Authenticated Chrome at `https://erp.boomeroff.com/pos` verified: 14 image/name groups; standard/custom tabs; Japan ceramics ascending prices including 12.9; two items total 25.80; central action rail; compact cart quantity; discount dialog with points entry. Test cart cleared. No sale, payment, refund or stock mutation submitted.
- Read-only production schema compatibility passed. `pos_points_rules` remains absent (`PGRST202`), so redemption is disabled. Safe cancellation RPC also still needs the separately reviewed migration; unknown sale outcomes must not be treated as cancellation success.
- User explicitly prioritized POS completion before mini-program publishing. The coordinating task was told to pause mini-program release and related production changes.

## Local Evidence

- Web logs: `/tmp/boomer-pos-web-tests-final.log`, `/tmp/boomer-pos-web-typecheck-final.log`, `/tmp/boomer-pos-web-build-final.log`.
- Actual component screenshots: app workspace `previews/pos-unified-20261003/implementation/`.
- Android logs/report: `/tmp/boomer-pos-android-20261003/`; latest test/build `owner-final-verify.log`, independently rebuilt in `main-final-verify.log`; APK: app workspace `android/app/build/outputs/apk/debug/app-debug.apk`.
- iOS logs/results: `/tmp/boomer-pos-ios-20261003/`; latest POS result: `cash-recovery-handoff-tests.xcresult`, build log: `cash-recovery-device-build.log`.
- Integration and activation contract: `docs/pos-points-redemption.md`.
