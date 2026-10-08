# Measurement And Detail Image Plan

**Goal:** Retouch measurement/detail photographs to square light-gray backgrounds, remove real human hands, preserve ruler marks/numbers and detail camera angles.

**Architecture:** Classify measurement/detail/general using the existing vision request. Use the existing cloud image editor for all images. Protected images forbid rotation, perspective changes and cropping; pad to square. Compare source/output with a cloud vision check for real-hand removal, product fidelity, clean gray background, ruler fidelity and unchanged detail angle. Invalid or uncertain checks fail for the existing durable retry, never report an unchanged original as a completed retouch.

**Tech Stack:** Existing Gemini gateway, sharp and Node TypeScript tests. No new local model/runtime, migration or native contract change. Classification/generation/check deadlines are 60/60/45 seconds; this remains a background task and does not block listing.

- [x] Add failing tests for hands, protected-image routing and source/output validation.
- [x] Implement cloud retouch and strict output checks; normalize EXIF display orientation before classification.
- [x] Run 54 focused image unit tests locally; these use mocked cloud responses, not real photographic acceptance.
- [x] Run 20 existing durable image-job regression tests and focused strict TypeScript checks. Final combined run: 75 tests passed, zero failures. No full application build or live-image acceptance yet.
- [ ] Exercise the real gateway on isolated image fixtures, save before/after evidence, inspect boundaries and ruler digits; no product/inventory writes.
- [ ] Build an isolated Tencent candidate from current live source with only scoped changed files, workers disabled. Verify login and worker guards; retain rollback, publish and recheck public routes.
- [ ] Commit/push the scoped implementation to GitHub and report verification separately from real photographic acceptance.

## Evidence, Incident And Constraints

Native Gemini segmentation probes returned truncated mask payloads; contour probes produced inconsistent/inaccurate coordinates. An isolated BiRefNet-lite CPU probe preserved synthetic ruler pixels but left an unwanted background blob. A later probe did not finish, and SSH/HTTPS/TAT stopped responding. Tencent monitoring reported memory rising to 89.934% at 18:02 UTC; this is evidence of resource pressure, not proof of the outage cause. No production source, symlink, PM2 configuration or database was changed. The CPU approach is abandoned, and its helper/runtime imports have been removed from the application.

ERP instance identified through the existing Tencent API credentials: Lighthouse lhins-ogmfuc6m, ap-shanghai, 4 CPU/8 GiB, 180 GiB system disk. TAT reports Offline; the narrow command to stop only our test helper was rejected because the agent is offline. Server-restart approval requested; no reboot performed yet.

Cloud comparison is probabilistic, not pixel-level proof or a guarantee of accuracy. Real photographic samples with ruler ticks, a hand holding a ruler/product, and detail marks need visual acceptance before release. Never invent hidden markings or production years. Distinguish real human limbs from dolls, sculptures and printed character art. Original images remain available when validation fails.

Local unit tests do not establish live gateway compatibility, processing speed or publication. The draft deployment script that would install the CPU model has been removed. A safe scoped candidate and rollback must be prepared only after server recovery and real-image acceptance.
