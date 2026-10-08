# Fankuang Enrollment Release

## Contract

`inv_skus.fankuang_override` is nullable: null follows a positive price at or below CNY 49.90, true/false are explicit employee decisions. Tracked custom single products only; standard, unlimited and bundle products are excluded. Price, barcode, SKU, stock and store ownership remain unchanged.

Creation and editing carry the raw field. PATCH omission preserves the saved choice. Public DTOs expose `in_fankuang`, and `fankuang=1` filters before pagination. Existing sold/hidden/archive/store-stock guards remain active. Existing catalog metadata caching retains its 30-second TTL; checkout independently verifies availability.

## Deployment

- Lovable embedded database migration: `0045_fankuang_override.sql`, applied; implementation SHA `15ef831a` includes `2191db54` and `11a651d`.
- Initial Tencent baseline: `staff-profile-20261007`. Final release: `fankuang-20261008-v2`, including the legacy mobile web creation sheet.
- `tencent-source.patch` applies to the audited initial baseline. `source-checksums.json` records every changed runtime file before/after. It deliberately preserves Tencent catalog paging/cache, image derivatives and inventory workers rather than replacing them with the older Git route.
- `scripts/deploy-fankuang-20261008.sh` builds/publishes v2 from v1 with candidate workers disabled, immutable candidate hashes and automatic source rollback on failed public checks. Its rollback command restores v1. The original staff-profile release is also retained. The additive database column need not be removed for source rollback.
- Host worker configuration was retained unchanged. No real product, member, order, stock or Youzan write was used for acceptance.

## Verification

- Backend focused suite: 70 passed, zero failures (rule, handler, paging, detail, idempotency).
- Mini Program: 18 passed, zero failures.
- Android: full unit suite 195 passed, debug APK built. New rule test exercises automatic boundary and explicit overrides.
- iOS: five focused unit tests and one simulator UI test passed. The UI test moves from 59.9/off to 49.9/on, manually turns off at 9.9, then manually turns on and changes to 199. Signed iPhone build passed; not installed.
- Candidate/public catalog acceptance: 73 available listings, one enrolled under current live data, filtered total and page IDs match, DTO/list/detail/media checks passed, anonymous worker writes rejected, candidate authenticated workers disabled.
- Synthetic database transaction: smart-create false saved, stock 1, replay returns the same single SKU, changed fingerprint P0409; forced rollback followed by zero synthetic dependencies/SKUs/operation rows.

## Boundaries

`handheld_item_update` real DB calls were not run: its employee guard requires an Auth identity, synthetic Auth insertion is unavailable, and real accounts/products were intentionally excluded. Readback confirmed its existing role, scope, CAS, replay, standard/archived guards, audit and sync behavior; only service_role/postgres can execute it. Function md5s: update `1fc3781bb7dd068f4674ae3120f67033`, smart-create `513a270bab0235df3763ca0ed9f5e1f2`.

An unrelated broad-suite image worker test expects an obsolete `.select("id").maybeSingle()` source pattern and failed; no unrelated worker code was changed. PC dialog visual acceptance was blocked by browser-control timeouts. Native installation and customer Mini Program upload/publication are separate steps, not claimed here.

## Source Snapshots

The native and consumer checkouts currently have no Git remote and contain unrelated untracked work. `native-source.tar.gz` and `consumer-source.tar.gz` archive only files touched by this feature for recovery without staging the whole workspace. They are scoped snapshots, not stand-alone complete app repositories. Local editable source remains in its original checkout.
