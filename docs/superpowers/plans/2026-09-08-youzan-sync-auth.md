# Youzan sync authentication implementation plan

> **For agentic workers:** Use executing-plans and test-driven-development; execute inline in the existing isolated worktree. No deployment, production access, real sync, new secrets, or unrelated ERP endpoint changes.

**Goal:** Reject anonymous/public-key/employee-triggered privileged synchronization without breaking the three existing manual UI contracts.

**Architecture:** A small server helper shares fail-closed service Bearer verification, ERP `user_roles` HQ checks, and fixed loopback worker dispatch. The existing service-role environment key stays server-only. A disabled Tencent systemd template replaces headerless pg_cron only through a separately authorized cutover.

**Tech stack:** TanStack Start / TypeScript; existing Supabase admin client; Node VM regression tests; systemd templates.

## Task 1 — Authenticate routes and manual callers

- [x] Add `src/lib/youzan-sync/auth.test.mjs`: execute real stripped TypeScript handlers/helpers with only database/network/framework boundaries mocked. Missing/wrong/public-key/missing-env requests must reject before effects. Manual callers must reject anonymous/staff/manager/no-role/lookup-error and allow actual HQ roles.
- [x] Run `node --experimental-strip-types --test src/lib/youzan-sync/auth.test.mjs` and record business assertion failures before production changes.
- [x] Add `src/server/youzan-sync-auth.server.ts`; modify only the two public hooks plus the three manual sync functions and their existing dispatch helper in `src/lib/youzan.functions.ts`. Authenticate first, use `user_roles` scoped to authenticated userId, allow only `super_admin`/`hq_operator`, preserve inputs/results.
- [x] Dispatch only to `http://127.0.0.1:${ERP_PORT ?? '3005'}` with ports 3005/3006 permitted, service Bearer and `redirect: 'error'`; never derive an origin from request headers or URL.
- [x] Add authorized fixture setup to existing queue-wiring regression so previous queue 500/207 tests remain meaningful; run both test files.

## Task 2 — Safe scheduled runner and handoff

- [x] Add runner tests with fake fetch/process, then implement `scripts/run-youzan-sync.mjs`: fixed days3/slices3, protected environment key, no argv token, fixed loopback only, redirect error, bounded timeout, sanitized logging, fail on HTTP207/non-2xx/JSON okfalse/malformed/network failure or missing config.
- [x] Add `infra/tencent/boomer-youzan-sync.service` and `.timer` as templates only. Do not install/start/enable.
- [x] Document old-cron pause → protected release → authenticated read-only progress acceptance → new timer start → rollback, including candidate3006 vs production3005 separation and avoiding service-key output in SQL/argv/logs.
- [x] Run new tests, 42 original focused queue tests, scoped lint and diff check. Record exact pass counts and unverified deployment/live integration limits.
- [x] Prepare only this task's explicit files for the requested local commit; preserve worktree and return the resulting SHA to parent for cherry-pick; do not push.

## Final local verification — 2026-09-08

```sh
QUEUE_PGLITE_MODULE=/tmp/boomer-queue-tests.eNW0xX/node_modules/@electric-sql/pglite/dist/index.js node --experimental-strip-types --test src/lib/youzan-sync/queue-*.test.mjs src/lib/youzan-sync/auth.test.mjs scripts/run-youzan-sync.test.mjs
# 74 tests, 74 passed, 0 failed, 0 skipped; exit 0 (includes real local PGlite migration-chain tests)

/tmp/boomer-queue-tests.eNW0xX/node_modules/.bin/tsx --test src/lib/youzan-sync/cursor.test.ts src/lib/youzan-sale.test.ts src/lib/youzan-quantity.test.ts
# 17 tests, 17 passed, 0 failed, 0 skipped; exit 0

node_modules/.bin/eslint src/server/youzan-sync-auth.server.ts src/routes/api/public/hooks/youzan-sync.ts src/routes/api/public/hooks/youzan-sync-worker.ts src/lib/youzan.functions.ts --rule 'prettier/prettier: off'
# exit 0; only existing whole-file formatter rule disabled, no ESLint source rules disabled

node --check scripts/run-youzan-sync.mjs
git diff --check
# both exit 0
```

Total: **91 passed** = 49 new authentication/runner tests + 42 original queue/cursor/sale/quantity regressions. Node emitted only its experimental TypeScript-strip warning. No full application build/typecheck or deployed/systemd/live API acceptance was run in this isolated worktree; the parent integration task owns those checks. See the adjacent cutover document for exact safety boundaries and rollout procedure.
