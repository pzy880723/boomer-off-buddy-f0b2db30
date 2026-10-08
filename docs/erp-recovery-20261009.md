# ERP Recovery, 2026-10-09

## Verified Findings

- Instance: lhins-ogmfuc6m, Shanghai, 150.158.94.248. The attached incident report is historical diagnostic evidence, not deployment instructions.
- The Chromium executable referenced by systemd is absent. Installed a narrow drop-in with an executable condition, 300-second/3-start limit and 30-second restart delay. After reload: inactive, ConditionResult=no, NRestarts=0. Browser functionality is unavailable until its own dependency is restored; ERP does not require this browser.
- Ubuntu PM2 retained an older release path. More importantly, root-owned workers.env was mode 0600, unreadable by the ERP service user. Both the old and current entry failed with Permission denied. File contents were preserved; group ubuntu and mode 0640 now give only root/the intended service group access.
- A temporary root PM2 instance under TAT was serving the current release. Backed up its PM2 dump, handed ERP back to the existing enabled pm2-ubuntu service, removed only the duplicate root ERP entry and saved both dumps. Other applications were not restarted.
- Initial recovery retained fankuang-20261008-v2. Local and public login/handheld OpenAPI returned 200; verify-youzan-worker-guards passed without triggering production jobs. Listing release, image, Youzan stock/order/sale compensation/sync timers subsequently reported success. The subsequent feature release is documented below.

## Backups And Limits

The old release, database, application code and user photographs were not deleted. Configuration/PM2 backups remain in /var/backups and the original Ubuntu PM2 dump backup in /home/ubuntu/.pm2. Backups contain secrets and must not be committed or displayed.

The report's restart-storm explanation is plausible but not a proven sole cause: it reports no OOM/kernel failure at the final outage. No HARD reboot was issued in this recovery session. A previous SOFT reboot failed; the supplied report documents an externally completed reboot.

Two separate legacy jobs initially remained failed: BOOMER OPEN import rejected JSON, and shortage-refund retries required a token even while disabled. Their narrowly scoped recovery is documented below. The real automatic refund feature remains disabled and its token remains unconfigured.

## Feature Acceptance

The isolated retouch gateway canary completed in 19.1 seconds with classification, generated image and source/output review all HTTP 200. Output was accepted; no database, product or inventory writes occurred. This is one photographic sample, not exhaustive ruler/hand acceptance or publication.

Subsequently built and published listing-retouch-20261009-v2 with old-release rollback retained. Public login/manifest/catalog and worker guards passed. The release fixes valid uncertain-classification retries and adds product-list enrollment badges/filtering. Candidate manifest/link permission failures were investigated and corrected before reporting successful publication. PM2 startup state is saved under Ubuntu, with no duplicate root ERP process.

## Worker Recovery And Coordination

- Coordinated directly with the customer-app task and Tencent KiKi. The other task confirmed it was not changing ERP runtime, environment, PM2 or Chromium. KiKi acknowledged the division of work and no duplicate execution; its tools cannot enumerate pending cloud command tasks, so absence of such tasks is not proven.
- Fixed actual node-postgres binding of key_terms/risk_flags: JavaScript arrays must be JSON-serialized for jsonb columns rather than passed as PostgreSQL arrays. Three regression cases exercise the actual INSERT parameters and pg binding.
- The next failure exposed one attachment whose source project no longer exists. No target project with that legacy ID exists. The complete original attachment record is preserved privately in /srv/boomer-data/sync/boomer-open.sha256.quarantine/<source-digest>.json, mode 0600. The original COS file is unchanged. It is explicitly excluded from import, not silently discarded or guessed onto another store. Reconciliation still requires a valid source-project relationship.
- Successful import: 3 projects, 18 stages, 91 tasks, 224 source costs, 323 valid attachments and 3 contract analyses. Target totals include pre-existing records: 229 costs and 327 attachments. All 3 analysis rows have JSON arrays for both fields. A second actual run returned no-change with 1 quarantined attachment and did not rewrite the database.
- Fixed shortage refund CLI preflight to return refund_worker_disabled before checking credentials or making requests when the feature is off. Enabled-without-token still fails closed. Five regression cases verify these boundaries. No refund/payment was executed and no credential or feature flag changed.
- The corrected operational refund runner is /opt/boomer-erp-ops/recovery-20261009/run-shortage-refunds.mjs, selected by /etc/systemd/system/boomer-shortage-refunds.service.d/boomer-runner.conf. Future changes to the repository CLI must also update this operational copy or deliberately remove this override after validating the release CLI; changing current alone will not replace this runner.
- Both jobs now report Result=success, exit 0; both timers are active, and systemctl --failed is empty. Their inactive state between executions is normal for oneshot jobs. Ubuntu PM2 boomer-off-buddy is online with 0 restarts. ERP current still points to listing-retouch-20261009-v2 and both environment file hashes are unchanged. The deployed importer, transformer and operational refund runner hashes match local sources.
- 14 focused local tests passed. bash syntax and git diff checks passed. The deployment script refuses concurrent/changed importer state and enabled-refund diagnostics; it backs up before edits and restores worker files/override on failure without restarting ERP.

## Worker Rollback

The successful deployment backup is /var/backups/boomer-worker-recovery-20261009 (directory mode 0700). It contains the original importer/transformer, original refund unit, environment hashes, ERP release pointer and a custom-format dump of the 9 store_development tables. The dump manifest was checked with the matching PostgreSQL container tools. Two earlier failed attempts retained separate backups and automatically restored the worker files/timers; failed database transactions rolled back. Nothing was deleted.

For an intentional worker-only rollback, first coordinate with any active server operator and pause both timers, wait for in-flight jobs to finish, restore the two original migration files from that backup, remove only boomer-runner.conf, reload systemd and resume the timers. This restores the former job behavior (including its known failures). Do not automatically restore the database dump over newer business data. Leave the ERP current pointer, environment files, original COS assets and preserved quarantine untouched.
