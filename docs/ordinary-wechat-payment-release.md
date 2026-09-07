# Ordinary WeChat payment release / 2026-09-08

## Scope

Codex owns this backend implementation. Lovable does not need to implement it again.
The database is the ERP project's embedded Lovable database, not a separately managed Supabase dashboard.
The release adds headquarters ordinary-merchant collection for official, explicitly verified self-owned stores.
It does not replace or delete the legacy split-payment gateway. Existing orders retain their original route.

## Launch gates (do not skip)

- `STOREFRONT_PAYMENT_MODE` remains `legacy` until ordinary acceptance is complete.
- Mini-program checkout/payment flags remain disabled until acceptance.
- Verify the eligible store legal entities before setting `WECHAT_ORDINARY_OWNED_LOCATION_IDS`.
- Implement/approve server-authoritative freight pricing. Current old order API accepts client freight; that is not safe evidence of a production-ready checkout.
- Confirm a real mini-program login emits a proven mini OpenID/AppID pair, not the App OpenID.
- Obtain an explicit real-payment/refund test amount from the owner; do not charge/refund while the owner is asleep.
- Validate order, inventory, fulfillment, customer order view and ERP refund lifecycle on that authorized transaction.

## Credential handling

The ordinary key set is separate from the previous split-payment credentials.
Only server environment bindings hold the merchant private key, APIv3 key and reconciliation token.
Workerd has a virtual filesystem, so host PEM paths are not used at runtime.
`scripts/provision-ordinary-payment.mjs` validates the certificate and provisions bindings over SSH stdin,
creates a private backup, and refuses to overwrite an existing ordinary key set. It never enables ordinary checkout.
Never copy these bindings into VITE variables, frontend bundles, Git, Lovable chat, screenshots or logs.

## API and ledger

- New order: snapshot merchant, AppID, customer, eligible stores, immutable amount/currency.
- Payment: fixed intent/out-trade number, query before retry, lease/CAS, signed HTTP 204 required before closing.
- Unknown result: retain inventory and reconcile; do not turn timeouts into failed/refunded orders.
- Notification: raw signature verification then AES decryption then merchant/order/amount checks then atomic ledger write.
- Refund: HQ authorization, approved after-sale amount, original merchant, fixed refund number and reserved cap.
- Reconciliation: `/api/internal/payments/reconcile`, server Bearer token, bounded batch, oldest-first checks.
- Historical ordinary orders still reconcile/refund through ordinary credentials if the new-order default later changes.

## Verification

- Protocol/flow/config/auth/refund/reconciliation: 57 tests.
- PGlite real SQL transactions: 15 tests, including legacy independently extended/cancelled reservations.
- Workerd integration: RSA request/payment signing, signed response verification, AES callback decode, ephemeral keys only.
- Real credentials: read-only non-existent order query, verified signed `ORDER_NOT_EXIST`; no order or payment created.
- Lovable: full migration inside one transaction and ROLLBACK; independent schema read-back required before apply.

## Deployment

Baseline 02e7ae9 differs from running 7396e9 only in `.lovable/plan.md`; do not merge unreviewed GO main changes.
ERP runs under **root PM2** on Tencent Cloud. The ubuntu PM2 process with the same name is stopped and is not production.
Coordinate port 3006 with the GO task before deploying. Keep previous release and environment backup.
Apply the reviewed additive migration atomically, including schema migration history and PostgREST schema reload.
Run `scripts/deploy-ordinary-payment.sh` as root with exact reviewed commit and expected previous release.
It probes a candidate on 3006 before swapping 3005 and restores the previous process/symlink on failed checks.
Public HTTPS and database read-back are required in addition to the local candidate tests.

## Rollback

Rollback application release to the preserved previous path; leave additive database columns/functions intact.
Do not drop payment/refund snapshots or restore the old expiry function once any ordinary order exists.
Legacy expiry behavior is preserved in the new function; unknown ordinary payments must retain inventory.
Do not delete ordinary credentials after an order has used them, even if the new-order switch is reverted.
The consumer API's new nullable mini AppID column is also additive; never relabel historical OpenIDs using a new environment AppID.
