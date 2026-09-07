# Queue hardening verification and handoff

Base: `a10207463d7aa5c18c558d92198529dca46b5924`.
Branch: `codex/go-queue-hardening`; worktree preserved, no commit/push/deployment.

## Exact scope

- `src/lib/youzan.functions.ts`: HTTP error rejection; strict queue order-list/id checks; isolated fenced queue commit callback; source update timestamp; per-version failure ownership; queue Shanghai query bounds; bounded continuation past legacy page 500. Manual successful sync/stock path remains unchanged.
- `src/server/youzan-order-sync.server.ts`: atomic window rearm RPC, unique per-claim lease owner, fixed scan cutoff, fenced batch callback and honest open-scan/lease-lost result.
- `src/routes/api/public/hooks/youzan-sync.ts`: unique cron IDs; 500 for queue infrastructure failure; 207 with `ok:false` for unsuccessful slices.
- `supabase/migrations/20260907180726_youzan_queue_hardening.sql`: removes actual legacy status CHECK; adds scan metadata and source version; queue RPCs lock cursor during order upsert; conditional source-version writes also inspect legacy/manual raw data.
- Three new local regression files under `src/lib/youzan-sync/queue-*.test.mjs`; this plan and verification note.
- No changes to GO identity, roles, sales aggregation, account data, dependencies/lockfiles or other worktrees.

## RED evidence

- Initial function regression: 5 failed / 1 passed. HTTP 500 `{}` did not reject; empty version concealed failed nonempty write; unknown list completed successfully; queue bypassed commit callback; wrote directly instead of carrying source version.
- Initial real PostgreSQL migration-chain test (PGlite): 5 failed. Actual `youzan_order_sync_cursors_status_chk` rejected `failed`; scan cutoff and new RPCs absent.
- Worker/cron wiring: 4 failed. Enqueue never called rearm; window_end used instead of scan_end; cron returned 200 for both infrastructure and slice failure.
- Added targeted RED: malformed nonempty order returned success; legacy raw version 300 overwritten by older 200; stale replay incorrectly accepted for inventory; page 501 returned null continuation instead of 503.

## Final commands and results

```sh
QUEUE_PGLITE_MODULE=/tmp/boomer-queue-tests.eNW0xX/node_modules/@electric-sql/pglite/dist/index.js node --experimental-strip-types --test src/lib/youzan-sync/queue-*.test.mjs
# 25 tests, 25 passed, 0 failed; exit 0

/tmp/boomer-queue-tests.eNW0xX/node_modules/.bin/tsx --test src/lib/youzan-sync/cursor.test.ts
# 9 tests, 9 passed, 0 failed; exit 0

/tmp/boomer-queue-tests.eNW0xX/node_modules/.bin/tsx --test src/lib/youzan-sale.test.ts src/lib/youzan-quantity.test.ts
# 8 tests, 8 passed, 0 failed; exit 0

node_modules/.bin/eslint src/server/youzan-order-sync.server.ts src/lib/youzan.functions.ts src/routes/api/public/hooks/youzan-sync.ts --rule 'prettier/prettier: off'
# exit 0; full-file existing formatting intentionally not rewritten

git diff --check
# exit 0

node_modules/.bin/tsc --noEmit --pretty false --incremental false
# canceled after 2m47s, no diagnostics emitted, exit 130; NOT a successful typecheck
```

Node emits its standard experimental stripTypeScriptTypes warning. The test VM runs the actual source functions with only network/database boundaries replaced; SQL tests run original migration definitions plus corrective migration in disposable in-memory PostgreSQL. This is not a deployed Supabase/PostgREST or real concurrent multi-process test.

## Coverage contract for GO aggregation

- `scan_end`: fixed per complete scan, initially `min(window_end, now - 1 minute)` rounded to a second; continuation keeps it unchanged.
- `last_completed_scan_end`: published only when every page of that scan has succeeded. Represents update-query coverage `[window_start,last_completed_scan_end]`, not source freshness inferred from local log time.
- `last_completed_at`: when that complete scan finished; can be used for age/as-of display.
- `next_run_at`: scheduling/backoff only, not freshness.
- Open scan completion leaves `status=pending`, resets page 1 and scan_end, waits 30 minutes, and preserves last_completed metadata. Completed lookback windows are rearmed atomically after 30 minutes without resetting active pagination.
- Existing done rows have no trustworthy coverage proof: migration returns them to pending without inventing completion watermarks. Existing orders and logs are retained.
- Query filters are `start_update/end_update` (not creation time), explicitly Shanghai formatted in the queue path. An old-created order updated today belongs to today's update window.
- There is no whole-history backfill-complete flag. Default cron lookback remains 3 days, explicit enqueue default 30 days, maximum 180. Changes exposed late beyond the configured update lookback and initial historical gaps cannot be claimed covered. Offset pagination is not an upstream immutable snapshot guarantee. Refund completeness remains outside this work and must stay false where absent.

## Release prerequisites / unverified

1. Parent independently reviews/merges migration and code with Lovable identity work. Generated Supabase types may be regenerated in merged tree; queue wrappers do not require generated declarations.
2. Stop/drain old workers during migration/code cutover: the old binary does not use the new fenced commit callback. Do not run mixed old/new queue writers.
3. Confirm real Youzan payloads contain a recognized authoritative source update timestamp (`modified`, `update_time`, `updateTime`, `updated_at`, `updatedAt` in supported trade nesting). Missing timestamps fail the entire queue batch; local updated_at is never substituted.
4. Verify actual production DB permissions, grants, transaction lock behavior under two concurrent sessions, PostgREST serialization and source-version comparison with real redacted fixtures. PGlite tests do not substitute for this.
5. Inventory processing remains after accepted row commit, outside that SQL transaction, using existing idempotent stock semantics; stock failures retain prior behavior. No new refund or stock repair workflow was introduced.
6. Throughput depends on existing cron slice budget; fresh/as-of display must not imply current data while backlog remains. A completed update window is not a guarantee of all payment-history coverage.
7. Full repository typecheck/build, public route readback, live synchronization and intended-device acceptance were not completed here.

No credentials read, no production SQL/API writes, no remote Youzan calls, no commits or push. Temporary PGlite/tsx install lives outside the repo. The isolated worktree has an ignored node_modules symlink to the existing erp-pc runtime; no project dependencies were installed or changed.
