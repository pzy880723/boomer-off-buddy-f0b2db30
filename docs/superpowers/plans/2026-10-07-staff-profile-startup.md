# PC-Owned Employee Profiles and Fast ERP Startup

Approved scope: employee accounts, names and avatars are maintained only by authorized administrators in PC ERP. ERP mobile and Boomgo are read-only consumers. Preserve all current navigation and store permissions.

- [x] Persist the selected location with its owning account; render it before background validation. Test offline startup, logout/account isolation, revoked locations and stale async responses.
- [x] Make handheld login/me and web read the canonical ERP employee name/avatar, without technical email fallbacks. Keep authorization live on the server.
- [x] Add administrator-only avatar maintenance to existing PC account management and read-only ERP/GO profile APIs. Use the existing verified GO-to-ERP identity mapping, never phone matching.
- [x] Show avatars in ERP mobile and GO without adding mobile editing. Test profile mapping without modifying shop context or permissions.
- [x] Run targeted native/backend tests; publish a rollback-safe Tencent candidate preserving current production overlays; verify public routes and document remaining device acceptance.

No new account creation flow, consumer identity changes, store-scope changes, or mobile employee maintenance is included.

## Verification and Release

- Published on 2026-10-08 to `https://erp.boomeroff.com`, release `/var/www/boomer-erp/releases/staff-profile-20261007`.
- The authenticated PC account management page shows the canonical staff name in the top bar and per-account avatar maintenance controls. No real employee metadata was changed during acceptance.
- Account/GO profile endpoints reject anonymous reads with 401 JSON; login hydration and production worker guards pass. All worker configuration checksums and existing timers were preserved.
- Backend profile tests: 4 passed. iOS authentication/location regression suite: 45 passed with signed simulator tests. Android profile unit test and debug build passed. GO profile/session/shop-context tests: 31 passed; targeted analysis clean.
- Mobile builds are not installed on physical devices yet. Real avatar upload, cross-device photo refresh and physical-device cold launch remain acceptance items; a build or simulator test is not evidence of device installation.
- Previous production source is preserved at `/var/www/boomer-erp/releases/sale-compensation-v3-20261007`. Roll back with `sudo bash /tmp/deploy-staff-profile-20261007.sh rollback`; this restores code without deleting employee metadata or avatar storage.
