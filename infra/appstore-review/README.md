# Independent Review Runtime

This is a persistent demonstration deployment, not a production database copy
or hidden reviewer bypass. Use the same ERP backend and iPhone release UI.

PostgreSQL is on an internal-only Docker network. The Auth, REST and local
Storage APIs additionally use a bridge for loopback port publishing. No
database port is published. API ports 3810-3812 bind only
to loopback. JWT and database credentials must be independently generated.
All records are fictional and visibly marked demo. No source table data,
production credentials, payment, SMS or Youzan channels may be copied.

Deployment root: `/opt/boomer-appstore-review`. Copy the checked-in compose and
minimal `init/roles.sql`, plus the pinned upstream `jwt.sql` init script there. Generate `.env`
with `generate-env.mjs`; it refuses to replace existing credentials. Start
with `docker compose -f compose.yml up -d`. Restore public **schema only**,
excluding scheduled jobs, secrets and table data; then apply necessary schema
migrations and reviewed seed SQL. Use `create-account.mjs` exactly once after
Auth is healthy. Credentials stay in private files, not Git or test output.

`bootstrap.sh` is the one-time Tencent bootstrap: stage `compose.yml`,
`generate-env.mjs` and `create-account.mjs` under `/tmp`, and stage the
checked-in role initializer as `/tmp/boomer-review-roles.sql`. It reuses only
the existing runtime's `jwt.sql`, not its passwords or user data.
`repair-initialization.mjs` is an initial-install recovery tool and refuses
to run once an account exists. Never use it to reset a working deployment.

The schema-only baseline and incremental manifest are separate steps. The
2026-10-10 deployment applied the 108 entries in
`deployments/appstore-review-demo-20261009/schema-increment.manifest`, then
seeded two fictional locations, three stock items, one fictional completed
order and one internal conversation. Reference catalog definitions created
by migrations are not imported customer or transaction data.

`seed-images.mjs` stores visibly marked illustrative demo images in private
Storage. `PUBLIC_APP_ORIGIN` points to `/review-runtime`; only its GET media
route is exposed. `SUPABASE_URL` preserves `/review-data` for Auth, REST and
Storage. All AI, SMS, payment and Youzan credentials remain absent. Manual
product operations work; external AI generation and physical printing are
not claimed as validated by this environment.

Run `verify-runtime.mjs` on the server with
`REVIEW_GATEWAY_ORIGIN=https://erp.boomeroff.com`. It verifies actual login,
reads, demo-only edits, image delivery, consent persistence, refresh, rejection
of demo credentials by production, and denial of headquarters access to the
demo store staff. Reports and credentials remain private on the server.

`gateway.mjs` is not authorization: it forwards the configured demo bootstrap
email and `rvw_` device token hints to the independent backend. Both upstreams
must enforce their own real Auth and device checks. A demo outage never falls
back to production. Do not switch Nginx until both backend auth boundaries
and all core read/write routes pass integration checks.

Rollback: restore the backed-up Nginx configuration and reload after `nginx -t`;
stop only the review gateway/backend/compose project. Keep review volumes for
recovery. Never issue `down -v`, remove production volumes or modify the future
migration database.
