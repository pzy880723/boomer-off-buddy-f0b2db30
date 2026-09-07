# Youzan Queue Hardening Implementation Plan

> **For agentic workers:** Use executing-plans and test-driven-development. Work only in codex/go-queue-hardening. No production calls, deployment, commit or push.

**Goal:** Revisit mutable/late order windows, prevent expired workers or old source versions from overwriting orders, and never report failed work as complete.

**Architecture:** Keep manual sync unchanged. A queue-only commit callback writes batches through a cursor-locked SQL function. Each scan fixes its end time; open windows pause before rescanning, and enqueue periodically rearms completed lookback windows. API decoding and fallback success are strict for queued order scans.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL/Supabase migrations. All SQL tests use a disposable local database runtime.

## 1. Reproduction tests
- [x] Add queue regression tests for HTTP failure/unknown payload, fallback empty-then-write-failure, mutable-window rescan, correct legacy CHECK removal, lease fencing and source-version ordering.
- [x] Run the focused test runner and record failing assertions before changing production code.

## 2. Queue-only commits and bounded polling
- [x] Extend the corrective migration with scan_end/next_run_at, atomic enqueue/rearm, claim, lease-checked batch commit, and done/open-window handling.
- [x] Require a fresh unique lease owner per claim. Pass scan_end and commit callback into runOrdersSyncSlice. Preserve existing inventory processing only after a batch is accepted.
- [x] Make source-version comparison atomic with upsert; do not infer source freshness from local updated_at. Unknown source update times fail the queue batch without replacing data.
- [x] Test expiry, replay, partial failure, new same-window orders, and late results locally.

## 3. Explicit failures
- [x] Reject HTTP failure and unknown order-list payloads in the queue path. A later nonempty failed attempt must override any prior empty success.
- [x] Return cron failure/partial failure instead of unconditional ok:true; use unique worker IDs.
- [x] Run focused tests, lint/type checks where dependencies permit, git diff --check. Hand off precise files and remaining live-verification gaps. Full-repository typecheck was canceled after 2m47s without output, not passed; see verification log.

## Acceptance fixtures
```text
same window scanned at 10:00 -> pending until next poll -> scanned at 10:30 from page 1
closed window done -> enqueue after poll interval -> pending page 1
A lease expires; B claims and commits v2; A commit v1 -> rejected, row remains v2
same order source timestamp v2 then v1 -> v1 cannot overwrite
first API version empty; next version returns row then write fails -> error, not done
HTTP 500 {} or HTTP 200 unknown object -> error, not empty success
attempt 8 -> failed persisted, cannot claim again
```
