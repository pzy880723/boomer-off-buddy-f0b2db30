# Youzan sync authentication: verification and Tencent cutover

## Scope and authorization boundary

This is a **local code/template change**, based on queue-hardening commit `4d64a35`. No production request, live synchronization, deployment, cron edit, secret creation, or systemd installation/enablement was performed.

- Both `/api/public/hooks/youzan-sync` and `/api/public/hooks/youzan-sync-worker` now require `Authorization: Bearer <existing server service-role key>`. The key comes from `SUPABASE_SERVICE_ROLE_KEY`; absent configuration returns 503, absent/wrong/public-key requests return 401 before body parsing or business work. The existing `/youzan-order-sync` endpoint keeps its existing contract.
- `syncYouzanItems`, `syncYouzanOrders`, `syncAllShops` attach `requireSupabaseAuth`, then read ERP `user_roles` for the authenticated `context.userId`. Only `super_admin` and `hq_operator` may start synchronization. No role is inferred from profile/store absence or browser-supplied role data. Role-read failures fail closed. Denied users do not reap logs, read shop data, sync, or dispatch; the authorization role lookup itself is read-only.
- Function inputs and successful results remain unchanged. Manual order synchronization and existing inventory idempotence semantics are not refactored.
- Worker dispatch is fixed to `http://127.0.0.1:${ERP_PORT ?? '3005'}`. Only `3005` (production) and `3006` (explicit candidate) are accepted. No URL/Host/forwarded-host-derived origin and no redirects. Fetch errors are logged only as a fixed message, never as a credential-bearing exception.
- There is no Youzan-sync-specific job token configured in source; the pre-existing Youzan proxy token is a different outbound trust boundary and is not reused. The payment reconciliation token is not reused. Service-role keys are highly privileged: keep the runner and its environment on the same trusted backend host.

## Tests and limits

The tests execute real stripped TypeScript route/helper/handler code in Node VM with database, network, and server-function framework boundaries mocked. They never call Supabase or Youzan. Registration of the existing authentication middleware is checked; full framework token validation and deployed browser/server bundling require the integration build and later runtime acceptance.

RED evidence:

- Authentication tests: 35 total, 31 failed / 4 passed against the original routes and functions. Failures included anonymous cron returning 200, public-key worker returning 200, missing-env fail-open, missing manual rejection/role query, and request-derived dispatch origin.
- Runner tests: all 14 assertions failed before adding the runner, including no job execution and no failure exit status.
- Initial GREEN: 35 authentication + 14 runner + 4 existing queue wiring = 53 passed.

Final verification commands and results will be recorded after the final run in the implementation plan.

Not verified here: full application build/typecheck, actual deployed Supabase roles/token validation, candidate/public-route acceptance, Tencent systemd execution, production environment compatibility, real Youzan API/data freshness, or production cron migration. A successful scheduled response verifies queue processing/result metadata and item-task dispatch, **not completion of asynchronous item sync**; inspect sync logs for that. Inventory reconciliation remains outside the queue SQL transaction with its previous idempotent behavior.

## Separately authorized cutover sequence — do not execute automatically

1. **Prepare, do not activate.** Preserve the existing release and rollback procedure. Put the runner and the two systemd templates into the candidate release. Ensure the existing protected server environment supplies `SUPABASE_SERVICE_ROLE_KEY`; do not display it, copy it into this document, create a new secret, store it in SQL/cron.job, or pass it in command arguments. Check environment file permissions/ownership and service-user read access without printing its contents. This template follows the existing `ubuntu` service user and `/var/www/boomer-erp/shared/.env`; verify those deployment assumptions before installation.
2. **Keep candidate and production distinct.** Candidate application/runner must explicitly use `ERP_PORT=3006`; production defaults to `3005`. Verify the app process and any runner EnvironmentFile agree. Do not run the scheduled write runner to probe the candidate, especially when it shares production credentials/database. The local-only dispatch intentionally targets the Tencent-hosted runtime and is not a Lovable-hosted worker deployment design.
3. **Pause the old headerless cron before changing the active contract.** Resolve exactly `youzan-sync-30min`, preserve its recoverable configuration without printing a full command or credentials, and pause it through the authorized release workflow. Do not leave it retrying unauthenticated after deployment; do not leave both schedulers active. Existing bounded update-window rescans allow a short planned scheduler gap, but verify backlog/coverage rather than assuming current sales freshness.
4. **Deploy the protected release.** Include both hooks, all three manual callers, shared helper and runner in the same release. Keep the new timer stopped while verifying. Never introduce a temporary anonymous/public-key compatibility fallback.
5. **Read-only acceptance before starting synchronization.** Use the existing authenticated `/api/public/hooks/youzan-order-sync` with `{"action":"progress"}` from a backend process that reads the protected environment; use fixed loopback, `redirect: 'error'`, and log only status/booleans/counts. Do not use shell-expanded `curl -H` secrets. Verify unauthenticated/wrong/public-key requests to the two protected hooks are rejected without side effects. Verify manual staff denial and HQ identity in a controlled acceptance environment before any authorized sync. Ensure no service-role credential is in browser assets/logs.
6. **Start only the new timer after acceptance and authorization.** The template's `OnUnitInactiveSec=30min` schedules the next run after the previous runner exits. Each runner posts exactly `days:3, slices:3`; it times out at 590s under a 600s service limit. It exits nonzero for HTTP207, non-2xx, malformed JSON, `ok` other than boolean true, or transport errors. A client timeout does not prove server work stopped; inspect queue leases/progress before manually retrying. Verify the first authorized run, queue coverage metadata, item logs, and subsequent timer result. Never infer complete sales/refund coverage merely from HTTP200.
7. **Rollback safely.** Stop the new timer first; keep the old headerless cron paused. Prefer rolling back to a known protected release. If only an older anonymous version is available, apply an authorized external deny rule for the affected routes before restoring it; do not publicly reopen them just to restore scheduling. Restore scheduling only with an authenticated caller compatible with the active release. Keep a record of the gap and verify catch-up using queue progress/coverage.

The new service/timer files are templates only. This change intentionally contains no install script or migration that alters pg_cron or creates secrets.
