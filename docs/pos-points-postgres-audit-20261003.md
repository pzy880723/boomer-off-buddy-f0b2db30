# POS Points PostgreSQL Audit - 2026-10-03

## Decision

- Real PostgreSQL multi-connection regression: **16 passed, 0 failed**. This is not PGlite. Thirteen scenarios observed actual blocking between distinct backend processes using `pg_blocking_pids`, `pg_stat_activity`, and ungranted `pg_locks` rows.
- **Do not deploy only the cancel RPC/table.** A controlled counterexample returned `cancelled`, then successfully completed the same operation through the original v2. A safe release must atomically include the sale fence, shared operation lock, cancellation ledger, and runtime grants/revocations.
- **The complete existing migration is cleared for default-disabled installation within this audit's scope.** The live baseline, catalog and trigger-body checks found no remaining dependency blocker. The default-policy test exercised zero-point v2 checkout, its refund, safe cancellation and late-sale rejection with `enabled=false`, conversion fields NULL. This does not mean installation or live acceptance has occurred.
- A genuinely separate, smaller cancellation-only migration does not exist in this checkout. Extracting just its RPC is unsafe. Designing such a split would require wrapping every sale entry point and separately validating it; no business SQL was changed in this audit.
- Points activation remains blocked on an approved conversion policy. No approved points-to-money rate was found; the synthetic test rate must never become a production default.
- The trigger-body gate is closed using `tests/backend/pos-production-triggers-20261003.json`. All eight supplied functions are loaded verbatim with matching bodies/ACLs; nine relevant live trigger attachments run in the isolated suite. Pause/drain checkout requests for the atomic installation so old in-flight function calls cannot straddle the cutover. Retain READ COMMITTED and disabled/NULL rules.

## Scope And Release Safety

Audited worktree commit: `79819b8`, implementation commit `b52dfb8`.

Audited migration: `supabase/migrations/20261002174301_pos_points_redemption.sql`.

SHA-256: `e65f5fc66d11389e52ff37a2dc2d0d4d5e4dc057749f830568597e782e5acd48`.

Only test files, read-only preflight SQL under `tests/backend`, this report, and the new
`tests/sql/pos-points-postgres*-fixture.sql` files were added by this audit. The coordinating
task owns the production JSON snapshots; those files are read without modification.
Existing migration, API,
refund, payment, Web and native business source files were not edited. Other agents'
Web/request changes are outside this audit. No production connection, SQL deployment,
release switch, payment, or Lovable queue resumption occurred. The user's current
`mini-release-audit-20261003` release must not be replaced by the older POS release.

## Why The Rules Were Missing

The committed release evidence in `docs/unified-pos-20261003.md` states that the
Tencent release shipped the application without applying SQL and that its read-only
schema check received `PGRST202` for `pos_points_rules`. It also says cancellation
still required the separately reviewed migration. Thus the inspected release was
an application-only rollout, not a completed points/cancellation database rollout.

`src/lib/pos/points-policy.server.ts` deliberately maps missing-RPC errors
`PGRST202`/`42883` to disabled rules and NULL conversion values. Zero-point `/sales`
continues to call v2; positive points call v3 without fallback. Missing recovery
capability returns 503 `sale_recovery_unavailable` and cannot release client protection.

Fresh supplied catalog evidence in `tests/backend/pos-production-preflight-20261003.json`
was captured at `2026-10-03T04:32:29.895083Z`: PostgreSQL 17.6, old v2 present, all five
new RPC signatures absent, cancellation table absent, all three conversion columns
absent. This confirms missing database objects rather than merely a stale PostgREST
cache. The migration-history relation exists, but its rows were not included.
The coordinating task obtained these records using Lovable's read-only database
tool; this audit did not connect to production or resume the held message queue.

## Existing Rule Definitions

The membership seed in `20260817120000_commerce_membership_core.sql:187` and its
earlier timestamped equivalent defines:

| Plan             | Redemption cap | Earning multiplier | Monetary conversion |
| ---------------- | -------------- | ------------------ | ------------------- |
| free             | 0%             | 1.0                | Not defined         |
| explorer_monthly | 15%            | 1.2                | Not defined         |
| explorer_annual  | 15%            | 1.2                | Not defined         |

These are committed seed values. The coordinating task additionally reports live
free cap 0 and explorer cap .15, with all conversion columns absent. Neither a
15% cap nor a 1.2 earning multiplier defines a redemption exchange rate. The old
`benefit_rules` seeds contain coupon/personal-selling rules, not conversion units.

The new migration adds `points_redemption_enabled DEFAULT false`, nullable positive
integer `points_redemption_points_per_unit` and `points_redemption_unit_fen`, with a
constraint requiring both units before enablement. It reuses the existing cap.
Rules come from active, non-expired customer entitlements and active plans, with an
active free-plan fallback. The wallet remains `pos_customer_wallets.points` and
debits/credits are recorded in `commerce_points_ledger`.

Activation needs the policy owner's explicit unit pair and policy version, not an
inferred rate. Cash-only support and combined-discount authorization thresholds
(over 20 yuan or over 10% of eligible gross value) remain in effect. WeChat/Alipay
positive-points attempts are rejected before provider calls; this audit does not
create a points reservation or asynchronous payment-cancellation lifecycle.

## Real PostgreSQL Evidence

Runtime probe found Homebrew libpq 18.3 client/utility binaries but no `postgres`
server, no PostgreSQL listener on 5432, and no Docker CLI/socket. A temporary runtime
was installed outside the repository using
`@embedded-postgres/darwin-arm64@17.9.0-beta.16`; its reviewed local symlink hydration
script was run after an `--ignore-scripts` install. No system service was installed.
Package source: [embedded-postgres upstream](https://github.com/leinelissen/embedded-postgres).
Despite the package platform label, the executable reports PostgreSQL 17.9,
`x86_64-apple-darwin24.6.0`; this report uses the observed version, not the package label.

The harness accepts **no database URL**. It runs `initdb` in a fresh private `/tmp`
directory, rejects TCP auth, sets `listen_addresses=''`, and connects only through
its own private Unix socket. Connections A/B have `max:1` and different backend PIDs;
an independent observer inspects lock waits. A/B run the actual RPCs as `service_role`.
All data and prices are synthetic. The point conversion used inside enabled-policy
tests is deliberately test-only and is reset between tests.

Successful production-backup/trigger run: `/tmp/pos-pg-test-SZrVft/evidence.json` and `server.log`.
Backend PIDs: **58360 and 58361**. Migration hash is recorded above. The harness shuts
down its cluster after testing; the synthetic database/logs are retained.

| Regression                                                   | Observed wait/result                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Disabled defaults; legacy zero-points sale/refund; cancel    | Pass, wallet unchanged, no points ledger entries                            |
| Same wallet, different shifts and SKUs, overspend            | `Lock/transactionid`; one succeeds, other balance check fails               |
| First wallet debit rolls back                                | `Lock/transactionid`; waiting sale succeeds, only its effects remain        |
| Concurrent same op, zero points                              | `Lock/advisory`; one order and stock movement                               |
| Concurrent same op, positive points                          | `Lock/advisory`; one debit/order/stock movement                             |
| Cancel wins vs late cash                                     | `Lock/advisory`; late v2 raises `sale_operation_cancelled`                  |
| Cancel wins vs late points                                   | `Lock/advisory`; late v3 raises `sale_operation_cancelled`                  |
| Cash sale wins vs cancel                                     | `Lock/advisory`; cancellation returns original order, no tombstone          |
| Cancel transaction rolls back                                | `Lock/advisory`; waiting cash sale proceeds                                 |
| Duplicate concurrent refund op                               | `Lock/advisory`; one return/points credit                                   |
| Two shifts split refund 1+2 units, earlier status `refunded` | `Lock/transactionid`; 9.67+19.36 yuan and 1+4 points conserved              |
| Two shifts over-refund 2+2 of 3, earlier status `refunded`   | `Lock/transactionid`; second transaction fully rolls back                   |
| Refund credit vs new sale on same wallet                     | `Lock/transactionid`; credit and debit serialize, no overspend              |
| Same op v3 vs v2 altered payload                             | `Lock/advisory`; changed request rejected with `idempotency_conflict`       |
| Partial-deployment counterexample                            | Old v2 ignores a committed cancellation; confirms this deployment is unsafe |

The production legacy sale, discount and return definitions are loaded verbatim
from `tests/backend/pos-production-functions-before-20261003.json`, after asserting
their bodies and ACL match the committed predecessors byte for byte. A fresh
isolated cluster retains the original `public` schema and search paths: it does
not rename identifiers inside production function SQL. Body MD5 values:

| Function             | Live / fixture body MD5          |
| -------------------- | -------------------------------- |
| pos_complete_sale    | 84dd6e195341d8d1128f4e3f410ceac0 |
| pos_complete_sale_v2 | bd6d14561bbcea2861e4a1db63d3ab4f |
| pos_complete_return  | 04314a7097ea72cafbea623228fbfb7a |

All three are postgres-owned SECURITY DEFINER, `search_path=public`, executable only
by postgres/service_role in the supplied backup. The old v2 still leaves line totals
gross; no production net-allocation hotfix diverges from the tested wrapper.
Unlike the earlier PGlite fixture, this harness
replaces stock-function stubs with the committed `inv_apply_movement`,
`sales_sku_available_qty` and `sync_handheld_custom_listing` definitions. Reservation
tables are empty; the custom-listing hook returns early for these standard POS goods.
`auth.uid()` is a fixture stub returning NULL. The surrounding table DDL is minimal:
this is not a production clone and does not reproduce every trigger, RLS policy,
background job, wallet writer, custom/bundle/consignment path, or external provider.
The trigger-support fixture models only referenced columns/queue, not a full schema
export. SKU barcode generation, location setup, image enqueueing and custom-listing
paths are not exercised by standard cash sales.

Separately, real route/schema/auth code with stubbed transport passed **10/10**
API/contract tests, including staff/store access, absent migration, wrong-op outputs,
malformed results and unchanged zero-point v2 routing. This does not replace
authentication against the actual Lovable project.

## Production Preflight Review

- Required signatures and columns: none missing. No new-object naming collisions.
- Query/default isolation: READ COMMITTED, no recorded role/database isolation overrides.
- Six loaded legacy/stock function signatures and body hashes match the live catalog.
  The additional six-argument inventory overload is not called by these POS functions.
- 152 constraints validated, 84 indexes valid. POS order operation uniqueness,
  refund operation uniqueness, wallet primary key/nonnegative balance and ledger
  idempotency uniqueness are present. Reported status checks admit the tested sale
  and refund values; no new CHECK conflict was found.
- Eleven trigger attachments are reported. No wallet/points-ledger trigger is present
  in this capture. Eight supplied trigger function bodies/ACLs are verified and loaded
  unchanged, with all nine non-location attachments reproduced. Location setup
  triggers are excluded because these RPCs do not write locations.
- `commerce_resolve_order_coupon()` (MD5 `548c08b7efd0b59f0761aa6e1688eadd`)
  updates only coupons reserved by the affected order. It does not write money,
  points, orders or return quantities. The new default-disabled refund test executes
  its paid-order branch, preserves unrelated coupons, verifies full rollback with
  inventory queue/return records, and replays the same return without duplication.
- Ordinary-payment immutability guards payment route and ordinary-WeChat snapshot
  fields; these cash wrappers alter neither. Customer assignment applies only to
  storefront orders. Stock enqueueing performs a transactional queue upsert, not an
  external request; both insert/update paths run in the suite. No new deadlock,
  trigger error or duplicate side effect occurred in the tested races.
- Catalog, function-definition, and rule read-only SQL files were syntax-checked
  against the disposable real cluster before/after migration where applicable.
  Preflight snapshots describe structure, not full column type/default/nullability
  parity or a schema-complete staging exercise.

Read-only SQL supplied: `pos-points-preflight.sql`, `pos-points-rules-readonly.sql`,
`pos-points-function-definitions-readonly.sql`, and
`pos-points-trigger-functions-readonly.sql` (all under `tests/backend`).

## Installation Conditions

1. Live baseline functions, owners/grants, prerequisite columns, isolation, indexes,
   constraints and relevant trigger bodies passed this review. Apply only the exact
   audited migration hash, not a backlog. The old v2 leaves item line totals gross,
   matching the wrapper's allocation premise.
2. Pause/drain existing checkout requests before installation. Recheck object presence
   if any concurrent DB change occurred after the snapshot. This migration uses
   one-shot CREATE/ADD/RENAME and cannot be blindly rerun. Reconcile migration history
   through the deployment owner.
3. After installation, verify new RPC signatures/grants, disabled/NULL conversion
   fields, unchanged cap values and schema-cache visibility using read-only checks.
   The baseline JSON is backup evidence, not a complete rollback script after sales
   have been processed by the new functions.
4. Preserve the atomic BEGIN/COMMIT boundary. v2 must route through the guarded v3,
   both sale/recovery use the same `pos-sale:` transaction lock, and runtime roles
   cannot execute the unguarded core. Audit external callers of that revoked core.
   RPC isolation must remain READ COMMITTED. Never roll out only the cancel RPC.
5. Retain all rules disabled/NULL for a cancellation-only activation. Verify actual
   plan rows rather than seeding a rate or raising the free cap. This audit verifies
   the reviewed dependency subset, not all historical orders, custom/bundle paths,
   wallet integrations or a complete schema clone. Broader staging coverage remains
   advisable before expanding beyond the default-disabled recovery release.
6. Before any later points enablement, obtain approved conversion units and version,
   check the cash-only UI and authorization behavior, and perform the separately
   authorized payment/refund/device acceptance. Cancellation is not a cash refund
   or a provider cancel; native payment attempts still need their own lifecycle.

The baseline/signature/isolation/trigger dependency checks above are now complete.
No remaining blocker was found for the scoped default-disabled installation.
Deployment conditions still apply: pause/drain in-flight checkout, apply only this
exact migration atomically, retain disabled/NULL rules and verify resulting grants,
signatures and schema-cache visibility. The metadata snapshot is not a full schema
clone or rollback script; broader staging coverage is advisable before enabling
points or broadening the release. Business conversion approval independently blocks
positive-points activation, not default-disabled installation. Preserve the
coordinating task's newest Web/native release; do not deploy older application builds.

## Reproduction

Use any compatible local PostgreSQL bin directory containing `postgres`, `initdb`,
and `pg_ctl`. No environment DB credentials are read by the harness.

```sh
POS_TEST_PG_BIN=/tmp/pos-pg-runtime-mYH2KP/node_modules/@embedded-postgres/darwin-arm64/native/bin \
  node --test tests/backend/pos-points-postgres.test.mjs

node --experimental-strip-types --test \
  src/server/pos-sale-recovery.test.ts src/lib/pos/points-routes-contract.test.ts
```

Each run initializes a different cluster, prints its evidence directory and shuts
it down in the test cleanup hook. A hard-killed test process may need explicit
`pg_ctl -D <printed-directory>/data -m fast -w stop`; never use an existing server's
data directory. Initial harness-only JSON parameter double encoding was corrected
by binding serialized JSON as text then casting to jsonb; no production SQL change
was needed. Trigger ACLs are compared as PostgreSQL aclitem arrays rather than raw
strings because equivalent grants can have different ordering. The final 16-test
run with production trigger definitions is green.
