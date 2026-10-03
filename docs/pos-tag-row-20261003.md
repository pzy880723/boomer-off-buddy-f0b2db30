# Compact Optional POS Tags

## Scope And Evidence

- Requested order: category, one narrow optional-tag row, then ascending prices.
- The already-open in-app POS was running the older price-first view with a
  bottom disclosure named `细分类（可选）`. No cart contents were removed; it was
  empty before attempting a refresh.
- Existing current source already placed tags before prices. This change makes
  that tag section one horizontally scrollable row instead of a multi-row box.
  Category selection, cart identity, pricing, membership, discount and payment
  behavior are unchanged. Tags remain optional.
- No Figma artifact was created for this narrow, user-specified layout repair;
  verification used the actual editable POS component and production route.

## Verification

- Regression first failed for the missing horizontal tag row, then passed.
- 19 component/catalog/held-cart tests passed:
  `node --import tsx --test src/components/pos/*.test.tsx src/lib/pos/standard-catalog.test.ts src/lib/pos/held-cart.test.ts`.
- `npx tsc --noEmit` and `git diff --check` passed.
- Local actual-component harness: no-tag 9.9 item and tagged 12.9 item produced
  separate cart lines, two items, total 22.8. The harness intercepted all API
  requests; no real transaction was created.
- Actual production UI verified at desktop and 390x844 viewport: Japanese
  porcelain heading, six optional category tags plus no-tag choice, then price
  grid. The last tag was selectable by horizontal scrolling on the narrow view.
  Tag selection was reset to none and temporary viewport overrides removed.
- The original browser tab hit ERR_NETWORK_CHANGED on refresh; a fresh in-app
  tab loaded successfully and was retained showing the new production view.

## Release

- Code commit `aa386f1`, pushed to main and codex/pos-checkout-density.
- Tencent current: `/var/www/boomer-erp/releases/pos-tag-row-aa386f1-20261003`.
- Previous release retained: `product-query-93576ab-20261003`.
- Only `src/components/pos/pos-catalog.tsx` was overlaid on the previous release.
  No SQL, API changes, inventory writes or payment operations were performed.
- Linux production build, candidate/public login hydration, worker guards,
  unauthenticated POS API rejection and exact deployed asset comparison passed.
- New POS asset: `index-Bj6UX_SK.js`. Old hashed assets are retained for open
  sessions; an existing session must refresh to load the new interface.

Rollback only while this remains current:

```sh
sudo env \
  POS_PREVIOUS_RELEASE=/var/www/boomer-erp/releases/product-query-93576ab-20261003 \
  POS_NEXT_RELEASE=/var/www/boomer-erp/releases/pos-tag-row-aa386f1-20261003 \
  POS_SOURCE_ARCHIVE=/tmp/boomer-pos-tag-row-aa386f1.tar.gz \
  bash /tmp/deploy-pos-20261003.sh rollback
```
