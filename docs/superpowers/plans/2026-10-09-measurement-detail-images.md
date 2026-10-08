# Measurement And Detail Image Plan

**Goal:** Retouch measurement/detail photographs to square light-gray backgrounds, remove real human hands, preserve ruler marks/numbers and detail camera angles.

**Architecture:** Classify measurement/detail/general using the existing vision request. Use the existing cloud image editor for all images. Protected images forbid rotation, perspective changes and cropping; pad to square. Compare source/output with a cloud vision check for real-hand removal, product fidelity, clean gray background, ruler fidelity and unchanged detail angle. Invalid or uncertain checks fail for the existing durable retry, never report an unchanged original as a completed retouch.

**Tech Stack:** Existing Gemini gateway, sharp and Node TypeScript tests. No new local model/runtime, migration or native contract change. Classification/generation/check deadlines are 60/60/45 seconds; this remains a background task and does not block listing.

- [x] Add failing tests for hands, protected-image routing and source/output validation.
- [x] Implement cloud retouch and strict output checks; normalize EXIF display orientation before classification.
- [x] Run 54 focused image unit tests locally; these use mocked cloud responses, not real photographic acceptance.
- [x] Run 20 existing durable image-job regression tests and focused strict TypeScript checks. Final combined run: 75 tests passed, zero failures. No full application build or live-image acceptance yet.
- [x] Exercise the real gateway on isolated record-player/bag photographs and a synthetic ruler fixture; no product/inventory writes. Inspected square gray-background outputs and synthetic ruler numbers/ticks. Real handheld ruler photographs remain a visual acceptance gap.
- [x] Build an isolated Tencent candidate from current live source with only scoped changed files, workers disabled. Publish listing-retouch-20261009-v2, retain fankuang-20261008-v2 rollback; verify public login, manifest, catalog, media and worker guards.
- [x] Commit/push the scoped implementation to GitHub (`0c18f4e`). This is not a production release.

## Evidence, Incident And Constraints

Native Gemini segmentation probes returned truncated mask payloads; contour probes produced inconsistent/inaccurate coordinates. An isolated BiRefNet-lite CPU probe preserved synthetic ruler pixels but left an unwanted background blob. A later probe did not finish, and SSH/HTTPS/TAT stopped responding. Tencent monitoring reported memory rising to 89.934% at 18:02 UTC; this is evidence of resource pressure, not proof of the outage cause. No production source, symlink, PM2 configuration or database was changed. The CPU approach is abandoned, and its helper/runtime imports have been removed from the application.

ERP instance identified through the existing Tencent API credentials: Lighthouse lhins-ogmfuc6m, ap-shanghai, 4 CPU/8 GiB, 180 GiB system disk. TAT reports Offline; the narrow command to stop only our test helper was rejected because the agent is offline. A SOFT reboot was requested during release recovery (request 38902b69-1bdd-4824-acce-1411270a4079). At 18:35 UTC on October 8, DescribeInstances reported RUNNING with RebootInstances FAILED; HTTPS still timed out. Explicit approval for a HARD reboot is pending; none has been issued.

Scoped cloud-canary, deployment and rollback scripts are prepared but have not run against the server. Three release-script checks pass locally, including candidate/public manifest checks before/after the production switch. They do not prove server build, gateway compatibility or publication. No production source, database or release symlink has been changed for this release.

Cloud comparison is probabilistic, not pixel-level proof or a guarantee of accuracy. Real photographic samples with ruler ticks, a hand holding a ruler/product, and detail marks need visual acceptance before release. Never invent hidden markings or production years. Distinguish real human limbs from dolls, sculptures and printed character art. Original images remain available when validation fails.

Local unit tests do not establish live gateway compatibility, processing speed or publication. The draft deployment script that would install the CPU model has been removed. A safe scoped candidate and rollback must be prepared only after server recovery and real-image acceptance.

## October 9 Recovery And Final Verification

The later supplied incident report documented an externally completed reboot. Recovery verified two independent startup faults: a missing Chromium executable with unlimited restarts, and workers.env unreadable by Ubuntu PM2. The browser now skips startup when its executable is absent and is rate-limited; ERP returned to the existing enabled Ubuntu PM2 service. See docs/erp-recovery-20261009.md; historical offline/reboot statements above are no longer current status.

The real bag canary initially rejected valid 0.9 classification confidence. Added a reproduced regression and conservative protected framing/review for uncertain valid classifications. Invalid detector payloads still fail; output review still requires every safety check and confidence >=0.95. Final focused local suite: 79 passed (including three release-script checks). Candidate Linux image suite: 76 passed. Cloud probes completed in approximately 19-21 seconds. No local CPU model was installed on the server for this release.

The first candidate exposed a manifest generated after compilation and failed its 404 check without a production switch. The initial publication then hit root-owned release-link permissions; the old application was restarted and verified. Corrected the source manifest before build and the privileged, narrow symlink switch; v2 publication subsequently passed and saved PM2 startup state. Candidate/public catalog: 73 available listings, 5 enrolled. This release also includes product-list enrollment badges/filtering, applied as a small patch to live source so unrelated Tencent optimizations are retained.
