# POS Optional Brand Tags

## Scope

- Preserve category -> optional type/brand -> price workflow and existing POS columns.
- Two compact horizontal rows: type/object shape and brand/kiln. Either can be skipped.
- Reuse all 86 active leaf types across 14 standard groups and 148 active brands/kilns.
- Category-relevant brands are ranked first; More Brands searches all names and aliases.
- Sanrio and San-X company IDs are allowed despite existing IP classification;
  character records are excluded. No shared SKU brand or historical order is rewritten.
- Each sale line keeps its optional brand ID and canonical name snapshot. Different
  brands of the same SKU/type remain separate; cart, hold/resume, cash/points and
  asynchronous provider payloads retain the selected identity.

## Verification

- 166 component, catalog, scanner, points, held-cart, payment and SQL tests passed.
  `node --import tsx --test src/components/pos/*.test.tsx src/lib/pos/*.test.ts src/server/pos-payment-subcategory.test.ts`
- `npx tsc --noEmit` and `git diff --check` passed.
- Six isolated PGlite tests load captured production sale/points function bodies.
  Cover same-SKU/different-brand orders and receipts, points idempotency/refund,
  null-brand compatibility, invalid/inactive/character brand rollback, held unique key.
- Actual POS component with intercepted APIs: choose cup + Noritake + 12.9, then
  cup + Narumi + 12.9 -> two rows, total 25.80; hold/resume preserves both labels.
  Alias search and 390x844 layout passed; document width remained 390px.
- Production browser: 14 groups; Toy Model shows plush/figure/model/boardgame/capsule
  types before brands and prices. More Brands contains 148 entries; San-X search works.
  Production cart remained empty. No production sale/payment/stock mutation was tested.

## Database

- `supabase/migrations/20261003113334_pos_sale_brand_tags.sql` was applied through
  the project's Lovable database connector after a successful transaction rollback
  dry run. The Lovable agent queue was on user_hold; it was not resumed. The queued
  agent was notified that the migration and main code were already completed.
- Four nullable columns verified across commerce_order_items and pos_held_cart_items.
- Function edits are guarded by verified baseline hashes, transactional and rerunnable.
  Existing function privileges remain unchanged; no direct client execute grant added.
- Post-apply body hashes: pos_complete_sale `d7547794011d45503c85944e4af03c38`;
  pos_complete_sale_v3 `c394a0313d263abdbdbc838cb7a4a962`.
- The query connector does not itself record a Supabase CLI migration-history entry.
  Lovable was asked to reconcile the applied migration record, without rewriting RPCs.

## Release And Rollback

- Code commit: bd2cb22, pushed to main and codex/pos-checkout-density.
- Tencent current: `/var/www/boomer-erp/releases/pos-brands-bd2cb22-20261003`.
- Previous: `/var/www/boomer-erp/releases/pos-tag-row-aa386f1-20261003`.
- POS asset: `index-CBFGVVr1.js`; Linux build, candidate/public login hydration,
  worker guards, exact asset comparison and unauthenticated 401 checks passed.
- Only reviewed POS source files were overlaid; unrelated live changes were retained.
- Old frontend assets and the previous release remain available. An application
  rollback may retain the additive brand columns; do not delete saved brand snapshots.

```sh
sudo env \
  POS_PREVIOUS_RELEASE=/var/www/boomer-erp/releases/pos-tag-row-aa386f1-20261003 \
  POS_NEXT_RELEASE=/var/www/boomer-erp/releases/pos-brands-bd2cb22-20261003 \
  POS_SOURCE_ARCHIVE=/tmp/boomer-pos-brands-bd2cb22.tar.gz \
  bash /tmp/deploy-pos-20261003.sh rollback
```
