# Xintiandi custom-listing inventory recovery

## Incident

The 18 custom products created from 2026-09-25 through 2026-09-26 03:53:24 UTC
had one unit each in ERP location `2df58305-57c1-4792-9920-3c3aa49890bc`.
Their publication outbox rows remained `pending`, with zero attempts. Stock
tasks failed with Youzan error `122001001` (product not found).

The Tencent timer was running but received HTTP 503 `worker_disabled` because
`HANDHELD_RELEASE_WORKER_ENABLED` had been lost when PM2 was recreated during
deployment. The complete publication path, which corrects remote channel IDs,
barcodes, prices and then warehouse stock, never ran for these products.

The independent `inv_skus.stock_qty=0` field is not proof of missing shop stock:
the authoritative shop quantity here is `inv_stocks.qty=1`.

## Confirmed Canary

- SKU: `470c4bbf-1660-4342-81a7-f02a783206fc` (PokeWalker).
- Target Youzan shop: `212291308`, warehouse `MD00003`.
- Before: warehouse quantity 0, generated barcode `P260926114761696`.
- After: warehouse quantity 1, ERP barcode `2007149916528`, price CNY 299.
- Target channel item `6450798826`; library item `5297200957` is not the POS ID.
- Both other branch channels were read back as absent/not displayed.
- No ERP inventory was increased and no duplicate product was created.

## Durable Fix

- Host-owned `/etc/boomer-erp/workers.env` persists both publication and item-sync
  worker flags across application releases and PM2 process recreation.
- The launcher reads this file only on production port 3005. Other ports force
  both workers off, even when inheriting enabled flags from PM2.
- Explicit production maintenance overrides still work.
- Worker logging now includes the response error code, making `worker_disabled`
  distinguishable from an unexplained HTTP 503.
- GitHub main commit: `4a81d77`.
- Active Tencent release: `/var/www/boomer-erp/releases/release-worker-recovery-20260926`.
- Previous release retained: `/var/www/boomer-erp/releases/item-delete-guard-20260926`.
- Server build was preserved unchanged; only launcher/operational scripts changed.
- No migration or iPhone application change was required.

## Verification

- All 18 affected products passed independent Youzan readback: quantity 1,
  matching ERP barcode and price, displayed in Xintiandi and not displayed in
  either of the other two branch channels. The backlog drain finished and its
  subsequent calls claimed zero remaining tasks.
- 34 focused tests passed: launch configuration, channel identity, barcode/price,
  branch isolation and archived-product stock protections.
- All three new configuration regressions failed before the launcher fix.
- Candidate worker endpoints returned authenticated HTTP 503 `worker_disabled`.
- Production process environment contains both worker flags as `true`.
- The production timer now receives HTTP 200 and completed outbox outcomes.
- Public API contracts and employee write authentication checks passed.
- `scripts/inspect-xintiandi-stock.ts <sku-id> --verify` reads ERP and Youzan to
  assert warehouse stock, barcode, price, publication and other-store isolation.

Physical cashier screen refresh and a real paid sale are separate acceptance
steps; no customer order/payment was created as part of this recovery.
