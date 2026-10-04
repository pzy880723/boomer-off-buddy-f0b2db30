# Transfer receipt and image delivery repair

## Diagnosis

- HQ's global read permission also enabled receipt. Detail, upload and receive did not carry the current operating location. Correct rule: the active authorized location must equal the destination, regardless of HQ read access.
- Transfer T-20261004-0001 was already received. Five positive stock rows were confirmed at the destination (Xintiandi) only. No historical transfer or inventory was changed.
- The receipt object exists (455,138 bytes). The two Baccarat processed PNGs exist (1,334,263 and 1,433,390 bytes). Direct reads succeeded during this investigation; the user's original network failure was not reproduced. Missing storage objects were ruled out for these three images.
- Receipt thumbnails previously fetched full images through changing direct Storage URLs with plain AsyncImage. Failed loads showed an indefinite spinner. Product lists also downloaded full PNGs.

## Changes

- Separate viewing access from receiving authority. Destination context is required for upload/receive; legacy handhelds use their authenticated device location. Web global view stays read-only until the user chooses the receiving location. Server rechecks each mutation.
- Return signed, one-hour, private receipt image links through Tencent. Signatures bind object path, image size and expiry; invalid/expired signatures fail before cache access. The bucket remains private.
- Serve 480px list thumbnails and 1600px full-screen images, preserving aspect ratio/orientation and the stored source objects. Bounded in-memory cache and concurrent-request coalescing; failed reads are not cached. Existing unrestricted SKU proxy behavior is not extended to receipt images.
- iOS receipt images reuse persistent product-image caching and the zoom/swipe viewer. Errors offer retry instead of an indefinite spinner. Current-location changes invalidate receipt detail/actions.
- Changes to iOS sources are in the existing local native source tree, not a new app or a data reset. Native source tree was already untracked by the ERP web repository.

## Verification

- Before fix: receipt-scope regression reproduced three failures (HQ at source, global view, legacy device context).
- After fix: 16 focused image/security/receipt/upload regression tests passed; 104 existing product/scope/image tests passed; isolated PGlite transfer suite passed; TypeScript and production builds passed.
- iOS: 42 existing image/transfer tests plus one new receipt thumbnail/cache-key test passed. Release build succeeded.
- Candidate and public read-only canaries verified the actual receipt and both Baccarat images, including decode/dimensions, warm-cache reads, invalid private signature rejection and source-location upload rejection. No products, transfers, sales, inventory or Youzan records were written.
- Receipt thumbnail: 26,573 bytes; full: 290,946 bytes. Baccarat thumbnail: 18,162 bytes; full images: 129,381 and 151,102 bytes. Public checks returned 200; independent Mac thumbnail read returned 200 in 0.452 seconds. These are measured network probes, not iPhone UI timing guarantees.
- Public login hydration, current POS assets and worker guards passed. No migrations or worker configuration changes.

## Release

- Backend code: `db78787`, pushed to GitHub main and `codex/transfer-receipts-media`.
- Tencent: `/var/www/boomer-erp/releases/transfer-media-db78787-20261004`.
- Rollback retained: `/var/www/boomer-erp/releases/handheld-upload-13d3536-20261004`.
- iPhone: `top.boomeroff.erp`, **1.1.28 (44)**, overlay installed and launched; installed version read back from the device. App data was not deleted.
- Lovable notified directly; no database migration requested and existing user hold preserved.
- Remaining acceptance: actual receipt/product pages have not been visually inspected on the physical iPhone after installation. No live new transfer was created/received solely for testing. Transient external/network outages cannot be promised never to recur.
