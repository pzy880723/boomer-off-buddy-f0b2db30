# Self-Operated Storefront Payments, Finance, and After-Sales Implementation Plan

> **Status: Deferred on 2026-07-16.** Current delivery work is limited to storefront products, shared inventory, orders, fulfillment, and store-owned after-sales. Finance and payment execution will be resumed as a separate approved project.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the BOOMER OFF custom-product sales loop across the consumer App, self-operated storefront, store operations, ERP fulfillment, payments, finance, and after-sales.

**Architecture:** ERP is the product, inventory, order, and accounting source of truth. The consumer App and BOOMER GO call versioned server APIs; stores receive fulfillment and after-sales work through ERP/store APIs. Payment providers are adapters around an immutable payment transaction and ledger model, while provider secrets stay in server-side secret storage and never enter browser-accessible tables.

**Tech Stack:** TanStack Start/Router, React Query, TypeScript, Supabase/PostgreSQL, Zod, Node test runner, WeChat Pay API v3 adapter, BOOMER GO API.

---

## Scope and boundaries

- Phase 1 supports custom products only. Standard products, bundles, and RFID remain hidden from the new flow.
- `inv_skus` and `inv_stocks` remain the product and physical-stock source of truth.
- `commerce_listings` is the self-operated storefront projection, not a second product master.
- Youzan is the store/POS channel only. The self-operated storefront never publishes to Youzan's online-store channel.
- Payment success is accepted only from a verified provider callback or an explicit test adapter disabled in production.
- After-sales belong to the source fulfillment store. Returned unique goods require inspection before stock or listings can be restored.
- BOOMER GO owns customer conversations; ERP owns order, fulfillment, refund, and after-sales state.

## Deferred multi-store settlement requirement

- One consumer checkout may contain unique products fulfilled by multiple stores while the customer makes one combined payment.
- The commercial sub-ledger must allocate each order line to its source store before any provider-level profit sharing is submitted.
- Order-level discounts, coupons, shipping income, payment fees, platform commission, and rounding differences require explicit allocation rules.
- Partial refunds must reverse the original line/store allocation snapshot rather than recalculate using the latest rules.
- Each store needs a separate receivable, settled amount, pending amount, refund, fee, and reconciliation view.
- Provider profit sharing and internal store accounting are separate states; a calculated store share is not considered settled until the payment provider confirms it.

## Phase breakdown

### Phase 1: Payment, finance, and after-sales foundation

**Files:**
- Create: `supabase/migrations/20260716090000_commerce_finance_after_sales.sql`
- Create: `src/lib/commerce/payment-policy.ts`
- Create: `src/lib/commerce/payment-policy.test.ts`
- Create: `src/lib/commerce/finance-schema-contract.test.ts`
- Create: `src/lib/commerce-finance.functions.ts`
- Create: `src/routes/finance.tsx`
- Create: `src/routes/finance.overview.tsx`
- Create: `src/routes/finance.payments.tsx`
- Create: `src/routes/finance.transactions.tsx`
- Create: `src/routes/orders.online.tsx`
- Create: `src/routes/orders.after-sales.tsx`
- Modify: `src/components/app-sidebar.tsx`
- Modify: `src/routes/shop-mgmt.online.tsx`

- [ ] Write failing policy tests for payment transitions, refund limits, immutable ledger balancing, and store assignment.
- [ ] Run `bun x tsx --test src/lib/commerce/payment-policy.test.ts` and verify the missing implementation fails.
- [ ] Implement pure payment and after-sales policy functions.
- [ ] Run the policy tests and verify they pass.
- [ ] Write failing schema-contract tests for provider configs, payment transactions/events, finance ledger entries, after-sales orders/items, distribution rules, and service-role-only mutation functions.
- [ ] Run `bun x tsx --test src/lib/commerce/finance-schema-contract.test.ts` and verify the migration is missing.
- [ ] Add the migration with immutable provider event IDs, amount-in-fen integer fields, idempotency keys, source location assignment, and balanced ledger constraints.
- [ ] Add `commerce_record_payment_success`, `commerce_create_after_sale`, and `commerce_post_refund` service-role RPCs.
- [ ] Run schema and policy tests.
- [ ] Add authenticated ERP server functions for finance overview, transactions, provider metadata, online orders, and after-sales queues.
- [ ] Replace the online-product placeholder with real `commerce_listings` data and four status tabs.
- [ ] Add real ERP pages for online orders, after-sales, payment configuration metadata, transactions, and finance overview.
- [ ] Add sidebar routes and run the production build.

### Phase 2: WeChat App Pay v3

**Files:**
- Create: `src/server/payments/payment-provider.ts`
- Create: `src/server/payments/wechat-pay-v3.server.ts`
- Create: `src/server/payments/wechat-pay-v3.test.ts`
- Create: `src/routes/api/public/storefront/payments.ts`
- Create: `src/routes/api/public/hooks/wechat-pay.ts`
- Modify: `src/routes/api/public/storefront/orders.$id.ts`

- [ ] Store only merchant/app/certificate metadata in `payment_provider_configs`; resolve private key and APIv3 key from server secrets.
- [ ] Write signature, response verification, callback verification, AES-GCM decrypt, and amount-validation tests from official fixtures.
- [ ] Implement App payment prepay and signed mobile parameters.
- [ ] Implement idempotent callback ingestion into `payment_provider_events`.
- [ ] Call `commerce_record_payment_success` only after signature, decrypt, merchant/app/order, currency, and amount checks pass.
- [ ] Add callback replay and duplicate-notification tests.
- [ ] Add payment query reconciliation for callbacks that were not received.

### Phase 3: Distribution, settlement, and reconciliation

**Files:**
- Create: `src/server/payments/profit-sharing.server.ts`
- Create: `src/routes/finance.settlements.tsx`
- Create: `src/routes/finance.distribution.tsx`
- Create: `src/routes/api/public/hooks/payment-reconciliation.ts`
- Modify: `supabase/migrations/20260716090000_commerce_finance_after_sales.sql` through a new additive migration.

- [ ] Define versioned distribution rules by store, promoter, franchisee, and campaign.
- [ ] Snapshot calculated shares when payment succeeds; never recalculate historical orders after rule changes.
- [ ] Distinguish `calculated`, `submitted`, `processing`, `succeeded`, `failed`, and `returned` provider states.
- [ ] Submit and query provider profit-sharing asynchronously.
- [ ] Reconcile payment-provider bills against transactions, refunds, fees, and distribution entries.
- [ ] Surface unmatched, amount mismatch, duplicate, and timeout exceptions in ERP.

### Phase 4: BOOMER GO customer-service bridge

**Files:**
- Create: `src/server/customer-service-contract.ts`
- Create: `src/routes/api/public/integrations/boomergo/conversations.ts`
- Create: `src/routes/api/public/integrations/boomergo/order-context.ts`
- Create: `src/routes/api/public/integrations/boomergo/after-sales.ts`

- [ ] Use service-to-service authentication and scoped API permissions.
- [ ] Let BOOMER GO create/read conversations and customer-visible messages.
- [ ] Expose masked order, shipment, and after-sales context to authorized store staff.
- [ ] Let BOOMER GO request after-sales creation, but keep approval/refund/stock-restoration decisions in ERP.
- [ ] Store external conversation IDs on ERP after-sales records for traceability.

## Acceptance criteria

- A custom listing can be reserved by exactly one unpaid order.
- A verified payment callback consumes the reservation once, decrements ERP stock once, marks the storefront listing sold, and creates fulfillment work.
- Store sales and storefront reservations cannot both consume the same unique item.
- Payment event replay cannot duplicate payment, stock, ledger, refund, or distribution entries.
- Finance entries use integer fen and every journal is balanced.
- An after-sales request is assigned to the source fulfillment store and is visible in a separate ERP queue.
- A returned unique item is not relisted before store inspection.
- BOOMER GO can exchange customer-service context without directly changing inventory or finance records.

## Validation commands

```bash
bun x tsx --test src/lib/commerce/*.test.ts src/server/**/*.test.ts
bun run lint
bun run build
```
