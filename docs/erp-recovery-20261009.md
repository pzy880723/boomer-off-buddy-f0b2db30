# ERP Recovery, 2026-10-09

## Verified Findings

- Instance: lhins-ogmfuc6m, Shanghai, 150.158.94.248. The attached incident report is historical diagnostic evidence, not deployment instructions.
- The Chromium executable referenced by systemd is absent. Installed a narrow drop-in with an executable condition, 300-second/3-start limit and 30-second restart delay. After reload: inactive, ConditionResult=no, NRestarts=0. Browser functionality is unavailable until its own dependency is restored; ERP does not require this browser.
- Ubuntu PM2 retained an older release path. More importantly, root-owned workers.env was mode 0600, unreadable by the ERP service user. Both the old and current entry failed with Permission denied. File contents were preserved; group ubuntu and mode 0640 now give only root/the intended service group access.
- A temporary root PM2 instance under TAT was serving the current release. Backed up its PM2 dump, handed ERP back to the existing enabled pm2-ubuntu service, removed only the duplicate root ERP entry and saved both dumps. Other applications were not restarted.
- Production remains fankuang-20261008-v2. Local and public login/OpenAPI returned 200; verify-youzan-worker-guards passed without triggering production jobs. Listing release, image, Youzan stock/order/sale compensation/sync timers subsequently reported success.

## Backups And Limits

The old release, database, application code and user photographs were not deleted. Configuration/PM2 backups remain in /var/backups and the original Ubuntu PM2 dump backup in /home/ubuntu/.pm2. Backups contain secrets and must not be committed or displayed.

The report's restart-storm explanation is plausible but not a proven sole cause: it reports no OOM/kernel failure at the final outage. No HARD reboot was issued in this recovery session. A previous SOFT reboot failed; the supplied report documents an externally completed reboot.

Two separate legacy jobs still need attention: BOOMER OPEN import rejects JSON, and shortage-refund retries have no configured token. No payment/refund switch or business data was changed to mask either failure. They are not evidence that ERP HTTP recovery failed.

## Feature Acceptance

The isolated retouch gateway canary completed in 19.1 seconds with classification, generated image and source/output review all HTTP 200. Output was accepted; no database, product or inventory writes occurred. This is one photographic sample, not exhaustive ruler/hand acceptance or publication.

Subsequently built and published listing-retouch-20261009-v2 with old-release rollback retained. Public login/manifest/catalog and worker guards passed. The release fixes valid uncertain-classification retries and adds product-list enrollment badges/filtering. Candidate manifest/link permission failures were investigated and corrected before reporting successful publication. PM2 startup state is saved under Ubuntu, with no duplicate root ERP process.
