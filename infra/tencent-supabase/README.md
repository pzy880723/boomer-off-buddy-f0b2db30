# BOOMER Tencent Data Platform

This directory contains the deployment and migration tooling for the future
BOOMER system of record on Tencent Cloud.

The complete cutover runbook is
[`docs/tencent-data-platform-migration.md`](../../docs/tencent-data-platform-migration.md).

## Why this is a Supabase-compatible stack

The current Lovable ERP does not use PostgreSQL alone. It depends on:

- Supabase Auth
- PostgREST through `@supabase/supabase-js`
- Row Level Security and JWT claims
- Storage buckets and signed URLs
- PostgreSQL RPC functions
- `pg_cron`, `pg_net`, `pgcrypto`, `pg_trgm`, and `uuid-ossp`

A plain PostgreSQL database would break login, images, permissions, scheduled
jobs, and inventory transactions. The target therefore runs the official
self-hosted Supabase Docker stack on Tencent Cloud.

## Production topology

```text
Lovable ERP / handheld / BOOMER OPEN
                  |
          https://data.boomeroff.top
                  |
             Nginx / TLS
                  |
          Supabase API gateway
      Auth / REST / Storage / Realtime
                  |
           PostgreSQL + Supavisor
                  |
        Tencent COS object storage
```

PostgreSQL is never exposed directly to the public Internet. Administrative
connections use a private network, an SSH tunnel, or Supavisor with a strict
security-group allowlist.

The Docker override binds Kong and Supavisor to `127.0.0.1`; Nginx is the only
public entry point.

## Capacity gate

Do not deploy onto the existing BOOMER OPEN host until it passes:

- 4 CPU cores recommended, 2 minimum
- 8 GB RAM recommended, 4 GB minimum
- 80 GB SSD recommended, 40 GB minimum
- at least 40 GB free disk before image pulls

Run:

```bash
sudo bash preflight.sh
```

The script is read-only and exits non-zero when the recommended production
capacity is not met.

## Deployment

1. Provision a dedicated Tencent Cloud Linux instance in Shanghai.
2. Attach a data disk and mount it at `/srv/boomer-data`.
3. Point `data.boomeroff.top` at the instance.
4. Install Docker Engine, Docker Compose, Git, OpenSSL, `jq`, and `curl`.
   Tencent Cloud hosts should install `docker-daemon.json` at
   `/etc/docker/daemon.json` so Docker Hub pulls use the Tencent mirror.
5. Copy this directory to `/opt/boomer-data-platform`.
6. Run `sudo bash generate-platform-env.sh` to create the private environment
   from the existing Tencent COS service account. It refuses to overwrite an
   existing file.
7. Run `sudo bash bootstrap.sh`.
8. Put `nginx-data.boomeroff.top.conf` into the Nginx site directory and issue
   a valid TLS certificate.
9. Apply the ERP migrations, beginning with the existing migration history and
   ending with `20260731070000_store_development_domain.sql`.
10. Run the BOOMER OPEN migration in dry-run mode, then commit mode.
11. Install the daily backup and health-check timers:

```bash
sudo bash ops/install-systemd.sh
```

The bootstrap script does not create paid cloud resources. It configures a host
that has already been approved and provisioned.

The stack uses ports `8100`, `8543`, `55432`, and `56543` so it does not
interfere with the existing BOOMER OPEN PostgreSQL service on `5432`. Database
files live outside the checked-out Supabase source at
`/srv/boomer-data/postgres`, so an application upgrade cannot replace them.

## Migration order

1. Back up Lovable Supabase with the official platform-to-self-hosted workflow.
2. Restore Auth, public schema, Storage metadata, functions, triggers, RLS, and
   extensions into the new isolated environment.
3. Copy all six Storage buckets to Tencent COS and validate object counts.
4. Apply the store-development migration.
5. Import BOOMER OPEN metadata. Existing COS objects are referenced in place.
6. Run read-only parity checks.
7. Switch staging clients to `data.boomeroff.top`.
8. Run a dual-write observation window before the final production cutover.

The isolated database container blocks the historical Lovable Youzan worker
hostname. Replace that old cron job with the Tencent API endpoint only when the
worker has been deployed and its queue checks pass.

## Historical migration compatibility

The repository contains three later, hand-named migrations that recreate
objects already created by earlier Lovable UUID migrations:

- `20260713090000_commerce_fulfillment_core.sql`
- `20260715090000_ai_product_classification.sql`
- `20260715153000_product_facets_and_brands.sql`

On a fresh Tencent restore, record these versions as applied before continuing
the migration replay. Do not edit the earlier production migrations:

```bash
supabase migration repair \
  --status applied \
  --db-url "$TARGET_DATABASE_URL" \
  20260713090000 20260715090000 20260715153000
```

After replay, compare the production and target `public` schemas. The target
must contain every Lovable table, column, function, policy, and trigger; only
the new `store_development_*` domain may be target-only.

## Backups and health checks

- PostgreSQL roles and a full custom-format dump are written daily under
  `/srv/boomer-data/backups`.
- Backups are private (`0700` directory, `0600` files), checksummed, and kept
  for 14 days by default.
- Supabase containers, Auth, REST, PostgreSQL, and free disk are checked every
  five minutes.
- BOOMER OPEN is synchronized into `store_development_*` every five minutes.
  The sync hashes the complete source snapshot and performs no database writes
  when the source has not changed.
- Tencent COS should have bucket versioning and a lifecycle policy enabled
  separately. Database backups do not duplicate COS object bodies.

To force a BOOMER OPEN reconciliation after restoring a backup:

```bash
sudo FORCE_SYNC=true /opt/boomer-data-platform/ops/sync-boomer-open.sh
```

Verify the most recent backup:

```bash
latest="$(find /srv/boomer-data/backups -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
cd "$latest"
sha256sum -c SHA256SUMS
```

Restore into an empty recovery instance first:

```bash
psql -U postgres -d postgres -f roles.sql
pg_restore -U postgres -d postgres --clean --if-exists postgres.dump
```

Never test restoration against the active Tencent database.

Do not use a raw, unfiltered `pg_dump` of the Supabase platform project. The
official restore workflow handles Supabase-owned schemas and permissions.

## Rollback

- Lovable Supabase remains authoritative until parity checks pass.
- BOOMER OPEN remains on `open.boomeroff.top` until its project, cost, contract,
  and attachment checks all pass.
- DNS is switched only after the old systems have a final immutable backup.
- The migration scripts are idempotent and preserve every source `legacy_id`.
