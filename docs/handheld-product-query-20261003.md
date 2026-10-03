# Handheld Product Query Latency

## Production Release

- Application commit: `93576ab`, pushed to GitHub main.
- Tencent release: `/var/www/boomer-erp/releases/product-query-93576ab-20261003`.
- Previous release retained: `pos-tags-cc2e894-20261003`.
- Only `src/server/handheld-products.server.ts` was overlaid on the previous
  release. Existing storefront, POS, membership and worker settings are retained.
- No migration, inventory correction, order, payment or refund was created.

## Narrow Change

Bounded single-location product dependencies request an exact row count. Once
all matching rows have arrived, readers no longer send an extra empty page.
Missing counts retain the exhaustive fallback; server-enforced smaller page caps
still paginate until the count is satisfied. HQ all-inventory/catalog reads keep
the uncounted path. Authorization, status derivation, counts, zero-stock location
membership and archived-product exclusion are unchanged.

## Evidence

- 102 targeted handheld product tests passed, including a 48-stock/448-standard
  fixture, truncated pages, missing counts, database failures, all scope, sold-out
  and warehouse history.
- `npx tsc --noEmit` completed successfully. The public handheld products route
  still rejects an unauthenticated request with HTTP 401 after deployment.
- Tencent Linux production build succeeded. Candidate and public login hydration,
  worker guard checks, existing POS asset equality and unauthenticated POS API
  rejection passed. No production jobs were manually triggered for verification.
- Read-only Tencent database-stage comparison for Xintiandi: 10 requests / 2679ms
  before, 5 requests / 1645ms with exact-count termination. Both returned 5
  locations, 48 stock rows, one eligible shop, 46 nonarchived location SKUs and
  448 shared standards. This is a single comparison, excludes authentication,
  signing, image downloads and device rendering, and is not a latency guarantee.
- Separate evidence for the reported Tiffany pair: paid at 16:09:41, stock
  reduced to zero at 16:11:35, then an iOS restock added one at 16:15:16 (all
  2026-10-03 Asia/Shanghai). Sale delisting preserves the catalog record. Under
  existing state derivation, display=false belongs to the warehouse filter.
  The restock was not reversed without confirming physical inventory.

## Rollback

Only while current resolves to the new release:

```sh
sudo env \
  POS_PREVIOUS_RELEASE=/var/www/boomer-erp/releases/pos-tags-cc2e894-20261003 \
  POS_NEXT_RELEASE=/var/www/boomer-erp/releases/product-query-93576ab-20261003 \
  POS_SOURCE_ARCHIVE=/tmp/boomer-product-query-93576ab.tar.gz \
  bash /tmp/deploy-pos-20261003.sh rollback
```

Native changes and device installation are tracked in the app workspace's
`docs/PRODUCT_STATUS_REFRESH_20261003.md`; this server release alone does not
update the installed iPhone UI.
