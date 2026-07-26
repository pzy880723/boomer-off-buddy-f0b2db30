# Commerce + POS Platform Implementation Plan

**Goal:** Complete the self-operated storefront transaction loop and add a store POS on the same ERP inventory and order ledger.

**Architecture:** Extend the existing commerce domain instead of creating parallel sales tables. Add quantity-aware reservations, payment facts and POS operational tables. Keep Youzan behind the existing channel adapter/outbox.

**Tech Stack:** TanStack Start, TypeScript, Zod, Supabase/Postgres, React, Flutter storefront client.

---

### Milestone 1: Quantity-aware commerce foundation

**Files:**
- Add: `supabase/migrations/*_unify_commerce_and_pos.sql`
- Modify: `src/routes/api/public/storefront/orders.ts`
- Modify: `src/server/storefront-products.server.ts`
- Test: `src/lib/commerce/unified-sales-schema-contract.test.ts`
- Test: `src/lib/commerce/storefront-order-request.test.ts`

1. Add failing schema and request-contract tests.
2. Add listing product type and quantity-aware order/reservation schema.
3. Add `commerce_create_order_v2(items jsonb, ...)`; retain the old RPC as a compatibility wrapper.
4. Update storefront order POST to accept `items[{listing_id,quantity}]`, while accepting legacy `listing_ids`.
5. Expose `available_qty` and `product_type` from product APIs.
6. Run targeted tests and production build.

### Milestone 2: Payment and refund ledger

**Files:**
- Modify: commerce/POS migration
- Add: `src/lib/payments/payment-policy.ts`
- Add: `src/lib/payments/payment-policy.test.ts`
- Add: `src/routes/api/public/storefront/payments.ts`
- Add: provider callback routes

1. Model payment intents, attempts, immutable events, refunds and reconciliation.
2. Implement state-machine tests.
3. Return `payment_not_configured` until provider credentials exist.
4. Implement idempotent callback processing and paid-order stock consumption.

### Milestone 3: POS backend vertical slice

**Files:**
- Add: `src/lib/pos/pos-policy.ts`
- Add: `src/lib/pos/pos-policy.test.ts`
- Add: `src/server/pos-auth.server.ts`
- Add: `src/routes/api/public/pos/bootstrap.ts`
- Add: `src/routes/api/public/pos/products.lookup.ts`
- Add: `src/routes/api/public/pos/shifts.open.ts`
- Add: `src/routes/api/public/pos/sales.ts`
- Add: `src/routes/api/public/pos/shifts.$id.close.ts`

1. Add register, shift, cash-movement and receipt schema.
2. Add role and location authorization.
3. Implement barcode/SKU/EPC lookup.
4. Implement atomic POS sale RPC with idempotent stock deduction.
5. Add shift open/close and cash reconciliation APIs.

### Milestone 4: Admin publishing and operations

**Files:**
- Modify: `src/lib/storefront-admin.functions.ts`
- Modify: `src/routes/shop-mgmt.online.tsx`
- Modify: `src/routes/orders.online.tsx`
- Add: POS management routes

1. Publish custom, standard and bundle SKUs from ERP.
2. Add product availability, channel and listing lifecycle controls.
3. Add payment, fulfillment, refund and exception visibility.

### Milestone 5: POS design and UI implementation

1. Produce Figma/HTML confirmation screens for all seven POS states.
2. Confirm visual direction before implementation.
3. Implement responsive desktop/tablet cashier UI.
4. Verify scanning, keyboard-only operation and 48 px touch targets.

### Milestone 6: Consumer app integration

**Files:** `/Users/boomer/Documents/BOOMEROFF/apps/mobile/boomer_off_app`

1. Replace `MockMarketRepository` with authenticated production repository.
2. Connect product list/detail, cart, checkout, orders and after-sales.
3. Keep flea-market `marketplace_*` domain isolated from self-operated commerce.

### Milestone 7: Release and migration from Youzan

1. Regenerate OpenAPI and client SDKs.
2. Run contract tests, build, migration verification and security advisors.
3. Publish ERP and validate production JSON routes.
4. Mirror Youzan orders into unified orders.
5. Pilot one store on POS before disabling Youzan cashier.
