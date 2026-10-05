# Tencent media source archival audit

This branch archives existing Tencent-deployed source that had not been committed.
It is not a new production deployment and is not ready for automatic merge.

## Source verification

On 2026-10-05 an SSH readback resolved production current to
`/var/www/boomer-erp/releases/nearby-coords-20261005`.
SHA-256 values of all nine runtime files below matched the local worktree exactly:

- src/routes/api/public/storefront/products.ts
- src/routes/api/public/storefront/products.$id.ts
- src/server/storefront-products.server.ts
- src/server/storefront-tencent-media.server.ts
- src/server/media-derivative.server.ts
- src/server/image-signature-cache.ts
- src/server/listing-image-source.ts
- src/server/storefront-catalog.server.ts
- src/server/storefront-filters.ts

The runtime files are archived unchanged. The branch starts at db78787, whereas
GitHub main contains later coordinate changes; do not deploy this entire branch
over production or merge blindly. Some catalog/cache helpers were already on
production before the October 5 media enhancement but absent from the Git base.
No credentials, environment files, customer records or image originals are included.

## Fresh verification and blocking gap

`npx --yes tsx --test src/server/storefront-media-delivery.test.ts src/server/storefront-tencent-media.test.mjs src/server/storefront-products.test.ts`

- Five media-specific tests passed.
- The existing storefront-products.test.ts suite failed to import:
  buildStorefrontProductDetail is no longer exported by the deployed module.
- The failed suite was not removed or weakened. Before merge, reconcile the
  current detail route with the old helper contract and rerun broader regression
  and TypeScript checks. This archival commit is not a claim that all tests pass.
- `git diff --check` passed before archival.
- Expanded derivative/paging/media verification: 22 tests passed, one failed.
  The paging source-inspection assertion still expects enrichment directly in
  the route instead of the extracted catalog loader. This second mismatch is
  also preserved for follow-up; passing media tests alone are not merge approval.

No production database, stock, payment, worker or server configuration was changed
in this archival task. Physical/mobile acceptance is not claimed.

## Lovable queue cleanup

The user approved removing 43 completed, duplicate or obsolete queued messages.
After removal and browser reload, the queue shows 8 messages, still paused.
Retained for verification: partial-refund shipping, offline-entry idempotency and
audit, smart-create profiling, historical missing SKU facets, product-card
candidate review, member purchase context, native recommendation-card API and
store-specific QR configuration. Retained does not mean approved for replay.

Routine completion notifications must not be enqueued as AI development jobs.
Codex can implement/test/version code and deploy Tencent directly. Existing
Lovable database/Storage ownership must still be respected until separately
migrated; Tencent application hosting alone does not migrate those services.
