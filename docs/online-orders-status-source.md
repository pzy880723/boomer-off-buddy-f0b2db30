# Online Order Status and Source

## Status

- A successful full refund takes display priority over stale fulfillment status and `closed`.
- `refund_pending` and `partially_refunded` remain distinct. A partial refund does not close the whole order.
- The database closes a fully refunded order only after reconciling its payment/refund ledger, with an audit record.
- Refunded orders cannot advance picking or create shipments. Existing shipment history remains intact.
- The ERP online-order list excludes POS orders, refreshes every 15 seconds while active, and refreshes on window focus.

## Source

`POST /api/public/storefront/orders` accepts optional `source_platform`: `miniapp`, `app`, or `web`.

The server records `metadata.sales_origin = {version: 1, platform, evidence}` through a service-role-only RPC after checking customer ownership. Replays preserve the first recorded origin and other metadata. On `order_source_pending`, reuse the original Idempotency-Key; do not create another order.

The current ordinary-payment flow verifies mini-program identity and AppID before recording `verified_miniapp_payment`. WeChat payment alone is not source evidence. Historical records without reliable evidence remain unknown.

`source_channel` remains the existing commerce-domain enum and is not replaced by UI labels. Source metadata is descriptive and must not authorize a customer, select a merchant, or assign stock.

## Boundary

External delivery-channel publishing, channel-specific order import, cross-channel stock propagation, and new fulfillment-allocation rules are not enabled by this display/source change. Existing stock and location-allocation logic is unchanged. Future adapters must keep per-location stock isolation, an external-order idempotency key, and server-authorized channel provenance.

## Release

Tencent candidate is built from the running release plus the reviewed patch, not from all unreleased main changes. The running payments route receives only origin persistence; the separate payment-router change already on main is not included. Keep the previous release for rollback. Additive database migrations and completed refund records are not reversed on a frontend rollback.
