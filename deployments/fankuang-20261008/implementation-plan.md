# Fankuang Enrollment Implementation Plan

**Goal:** Add the approved one-line enrollment switch beneath the price in listing and editing, with explicit staff choices honored by the consumer feed.

**Architecture:** The existing SKU owns nullable `fankuang_override`: null means automatic at a valid price <= CNY 49.90, true/false are manual decisions. Public APIs project `in_fankuang`; consumer feeds query `fankuang=1` before pagination. Stock, barcode, store scope and publication remain the existing single-SKU contracts.

**Tech Stack:** SwiftUI, Kotlin/Compose, WeChat JavaScript, TanStack Start, Lovable embedded PostgreSQL.

## Approved UI and Rules

- Keep existing layout; add `加入翻筐乐` beneath price. The same option exists in product editing.
- Automatic defaults track the price until the employee switches the option. Manual decisions survive price edits, recognition retries and saved drafts.
- Price 49.90 qualifies automatically; 50.00 does not. The literal <=49.90 threshold also excludes 49.91-49.99.
- Standard products never enter the consumer feed. Sold, archived or unpublished goods remain filtered out by existing live stock/publication guards.
- Preserve historical explicit enrollment tags without letting them override a later manual false.

## Execution

- [x] Backend/PC: nullable column, current-definition RPC changes, strict schemas, OpenAPI, read projections and pre-pagination filtering. Lovable applied migration 0045 and verified synthetic smart-create replay/rollback without real inventory changes.
- [x] iOS: optional override persisted in drafts and frozen submissions, parsed on list/detail, switches below price. Five focused unit tests and one actual simulator interaction test passed; signed device build passed.
- [x] Android: shared price/override evaluation, draft/item persistence, submission field, listing and authorized detail switches. Full 195-test suite and debug APK build passed.
- [x] Consumer Mini Program: canonical filtered feed, explicit false/true, retry pagination and live cart guards. 18 tests passed. Source changed, not uploaded or published.
- [x] Focused backend tests/builds: 70 tests passed; Tencent candidate and public API checks verified filtering, media, stock, login hydration and worker protections. iPhone simulator screenshot captured.
- [ ] Sync release evidence and client source snapshots to GitHub; native device installation and Mini Program publication are not performed in this task.

Validation examples: `49.9/null -> true`, `50/null -> false`, `9.9/false -> false`, `199/true -> true`; standard/zero stock/offline -> unavailable; retry sends the frozen override without creating another SKU.

Remaining acceptance: real authenticated PATCH mutation was not exercised because creating synthetic Auth identities is unavailable and real employee/product data was excluded from this test. Function/schema readback and application handler tests passed. PC dialog visual testing was blocked by browser control timeouts, not by API failures. An unrelated old image-worker source-pattern test failed in a broader run; focused feature tests and builds passed.
