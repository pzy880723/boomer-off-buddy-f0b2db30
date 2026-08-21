# ERP Membership Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete ERP membership-management entry with member search/detail, plans, coupons, points, consumption, and audited manual adjustments.

**Architecture:** Keep membership data in the existing Lovable-managed Postgres schema and expose admin operations through TanStack Start server functions. Read operations query existing membership tables; mutations call one transactional Postgres RPC and always append an immutable audit row. The React page uses existing ERP shadcn components and never writes Supabase directly.

**Tech Stack:** TanStack Start, React Query, TypeScript, Zod, Supabase/Postgres, Vitest, Tailwind/shadcn.

---

### Task 1: Lock the admin contract in tests

**Files:**
- Create: `src/lib/membership/membership-admin-contract.test.ts`
- Create: `src/lib/membership/membership-admin-presenter.test.ts`

- [ ] Write a route/navigation contract test requiring `/operations/members`, `会员管理`, and all six page tabs.
- [ ] Write presenter tests for free/paid status, 7-day expiry, usage, points, coupon count, and masked phone output.
- [ ] Run `npx vitest run src/lib/membership/membership-admin-contract.test.ts src/lib/membership/membership-admin-presenter.test.ts` and verify failure because the route and presenter do not exist.

### Task 2: Add audited database operations

**Files:**
- Create: `supabase/migrations/20260821150000_membership_admin_operations.sql`
- Test: `src/lib/membership/membership-admin-contract.test.ts`

- [ ] Add `commerce_membership_admin_audit_logs` with operator, customer, action, before/after JSON, reason, reference, idempotency key, and timestamps.
- [ ] Add `commerce_admin_adjust_membership(...)` as a `SECURITY DEFINER` RPC that handles entitlement, points, and coupon actions transactionally.
- [ ] Restrict RPC execution to `service_role`; enable RLS and grant audit-log reads only through the server-side service client.
- [ ] Extend the contract test to assert the migration includes mandatory reason validation, idempotency, and audit insertion.
- [ ] Run the focused contract test and verify it passes.

### Task 3: Build admin repository and server functions

**Files:**
- Create: `src/lib/membership/membership-admin-presenter.ts`
- Create: `src/lib/membership/membership-admin.functions.ts`
- Test: `src/lib/membership/membership-admin-presenter.test.ts`

- [ ] Implement `presentMembershipAdminRow` with masked phone and derived expiry/status labels.
- [ ] Implement `getMembershipAdminSummary`, `listMembershipAdminMembers`, `getMembershipAdminDetail`, `listMembershipAdminPlans`, `listMembershipAdminCoupons`, `listMembershipAdminPoints`, `listMembershipAdminConsumption`, and `listMembershipAdminAudit`.
- [ ] Implement `adjustMembershipAdminBenefit` with Zod validation, non-empty reason, idempotency key, and server-side `super_admin` authorization before RPC execution.
- [ ] Run presenter tests and the focused membership test suite.

### Task 4: Build the approved ERP page

**Files:**
- Create: `src/routes/operations.members.tsx`
- Modify: `src/components/app-sidebar.tsx`
- Test: `src/lib/membership/membership-admin-contract.test.ts`

- [ ] Add `会员管理` under `运营` and extend `NavTo` with `/operations/members`.
- [ ] Build the summary card, six tabs, member filters/table, detail sheet, loading/empty/error states, and refresh action.
- [ ] Build the audited adjustment dialog with type-specific fields, required reason, optional reference, confirmation, pending state, duplicate-submit protection, and query invalidation.
- [ ] Use existing ERP UI primitives; do not add a new component library.
- [ ] Run the contract test, `npx tsc --noEmit`, and `npm run build`.

### Task 5: Apply Lovable migration and verify live data

**Files:**
- Migration from Task 2.

- [ ] Query the Lovable project to confirm the existing membership tables and current row counts.
- [ ] Apply the migration through the connected Lovable project.
- [ ] Query `information_schema` and `pg_proc` to confirm the table/RPC exist.
- [ ] Exercise a rollback-safe read-only query against the new audit table; do not perform a real member adjustment without a business case.

### Task 6: Verify and release to Tencent ERP

**Files:**
- No additional source files.

- [ ] Run `npx vitest run src/lib/membership`.
- [ ] Run `npm run lint` and `npm run build`.
- [ ] Review `git diff --check` and confirm only membership/admin/nav/spec/plan changes.
- [ ] Commit on the current `codex/` branch and push.
- [ ] Run `npm run deploy:tencent` using the established candidate, health/login, rollback, and Nginx switch flow.
- [ ] Verify `https://erp.boomeroff.com/operations/members` through authenticated ERP access and confirm the public login/health routes still work.

