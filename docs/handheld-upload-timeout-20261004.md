# Handheld Original Backup Timeout

Date: 2026-10-04, Asia/Shanghai.

## Evidence

- User screenshot: AI recognition completed in 8 seconds; original backup reported `NSURLError -1001` (upload timeout).
- Tencent access logs: signing and recognition returned 200 during the failed 16:04-16:18 attempts; there was no corresponding new raw-storage object or successful smart-create.
- Read-only iPhone draft inspection: four local JPEGs, 796080 / 828045 / 812290 / 786090 bytes, zero backed-up slots. No draft changes or app reinstall were made.
- The storage buckets had no bucket-specific size or MIME restriction. The phone images were not oversized.
- A direct Tencent-to-Storage signed PUT succeeded in 1167 ms, including signing. A separate Mac direct PUT succeeded in 4565 ms. Both diagnostic objects were removed.
- These observations locate the reported failure in the phone-to-Storage upload path. They do not identify the precise network/operator/storage-edge trigger at the time of failure.

## Fix

Runtime commits: `3765957` and `13d3536`.

- Existing authenticated signing POST still supplies `storage_path`, `upload_url`, `method=PUT`, and headers. iOS and Android already honor those headers.
- Signed-mode uploads now go through the ERP origin, avoiding a separate direct phone connection to Storage. No app update is needed.
- The upload capability is HMAC protected, expires after 30 minutes, restricts storage origin/path and content type, and is carried in `X-Upload-Token`, not access-log URLs. No ERP device/session credential is forwarded to Storage.
- Uploaded bytes are unchanged. The body is bounded at 12 MiB, matching Tencent Nginx. The existing app normalizes captures before this upload, independently of this fix.
- Upload success requires upstream 2xx. Failures are not disguised as backed-up originals. No blind automatic replay of a non-upsert PUT was introduced.
- Logs include a request ID, result status, and duration, without capability values, photo bytes, or upstream error bodies.
- Existing draft retention and successful-slot retry behavior remain unchanged.

## Verification

- Regression test first failed against the original direct-Storage route.
- Final focused suite: 8 passing tests, including tampering/expiry, arbitrary-target rejection, oversized/empty bodies, exact forwarding, credentials isolation, upstream failures, and TLS termination.
- `npx tsc --noEmit`: passed.
- `node_modules/.bin/tsx scripts/check-openapi-drift.ts`: passed. Bun was not installed locally; no dependency changes were needed.
- First candidate (`3765957`) passed four uploads/readbacks, but the public endpoint exposed an HTTP origin after TLS termination. It was immediately rolled back to the previous release. A failing HTTPS regression test was added, then fixed in `13d3536`.
- Final candidate: four valid ~0.918 MB JPEGs uploaded and downloaded, with identical SHA-256 digests. Each signing/upload/readback took 3525-4018 ms.
- Final public endpoint: four valid ~0.918 MB JPEGs uploaded and downloaded with identical digests; 4492-5687 ms per signing/upload/readback.
- Separate Mac-to-public-ERP transport test: 1.1 MB, HTTP 200, 7756 ms including remote capability issuance. This test exercised transport, not photo rendering.
- All canary objects were removed. No products, orders, inventory movements or print jobs were created.
- Candidate and production login hydration, exact POS asset and worker guard checks passed. No SQL migrations or worker configuration changes.

## Release And Recovery

- Live release: `/var/www/boomer-erp/releases/handheld-upload-13d3536-20261004`.
- Previous release retained: `/var/www/boomer-erp/releases/pos-characters-a3c9450-20261003`.
- Release wrapper on Tencent: `/tmp/deploy-upload-20261004.sh`, using the established locked candidate/rollback pipeline. `sudo bash /tmp/deploy-upload-20261004.sh rollback` requires the current release to match before restoring the previous one.
- Code pushed to GitHub branch `codex/handheld-upload-relay` and fast-forwarded to `main`. GitHub connector PR creation returned 403; no PR was created.
- Lovable was contacted directly with diagnosis and API handoff. Its task queue was paused with `user_hold`; no queue was resumed and no Lovable changes are claimed.

## Remaining Acceptance

At report creation, the user was asked to tap the existing Retry Original Backup action. The exact four user photos have not yet been confirmed from their iPhone network after release. Server and Mac tests are not a substitute for that acceptance. No guarantee is made that arbitrary future network outages cannot interrupt uploads.
