# POS Points Redemption Backend

## Release Boundary

Implemented for cash-only checkout. WeChat/Alipay micropay and QR-order explicitly
reject positive `points_to_redeem` with HTTP 422 `points_async_not_supported` before
creating an attempt or calling the provider. The finalization function also rejects
unexpected stored positive points. No reservation lifecycle or asynchronous points
payment support is claimed. UI must label this limitation and must not drop points
and proceed with payment automatically.

No production SQL, deployment, live payment or Lovable queue resumption was performed.
The migration has only been applied to a disposable local PGlite database.

## Client Contract

`POST /api/public/pos/discounts/preview` accepts existing `location_id`, `items`,
optional `discount` (defaults to zero amount), plus optional `customer_id` (nullable)
and integer `points_to_redeem` (default 0, range 0..2147483647).

`data.points_redemption` contains:

```ts
{
  enabled: boolean;
  available_points: number;
  max_points: number;
  requested_points: number;
  applied_points: number;
  discount_amount: number; // yuan, NOT fen
  reason: string | null;
  cap_rate: number;
  points_per_unit: number | null;
  unit_fen: number | null; // conversion unit value in fen
  policy_version: number | null;
  supported_tenders: ["cash"];
  async_payment_supported: false;
  cap_basis: "eligible_after_discount";
  minimum_payable_fen: 1;
}
```

Outer `discount_total` and `payable_total` already include points and remain yuan.
Native clients using integer fen must convert at the API boundary, not subtract the
points discount twice. Redemption uses complete conversion units. Preview clamps
the requested points to wallet/cap/whole-unit limits; cash submission must explicitly
send the preview's `applied_points`. Submission never silently clamps or drops points.
Changes to wallet, price, eligibility, plan or rule between preview and completion
may reject the sale; request a fresh preview.

`requires_authorization` uses the combined manual-plus-points discount. For positive
points sales, the transaction enforces the same cashier threshold (over 20 yuan or
over 10% of eligible gross value). Above it, use a manager account or provide an
unexpired approved `order_discount` authorization for the operator and sale location,
issued by a manager. Points do not bypass this threshold. Zero-points legacy behavior
is preserved rather than silently changing the existing authorization policy.

Reasons: `points_rule_not_configured`, `customer_inactive`,
`membership_points_not_allowed`, `points_unavailable`, `points_request_capped`, or null.

`GET /api/public/pos/customers/:id/benefits` adds the same object with
`requires_cart_preview:true`. Its max_points is zero because no cart was supplied;
use discounts/preview to obtain an actual maximum.

`POST /sales`, `/payments/micropay` and `/payments/qr-order` all explicitly accept
`points_to_redeem`. Zero points uses the existing v2 sale RPC and needs no migration.
Positive points uses v3 only: missing migration gives HTTP 503
`points_rule_not_configured`, policy/balance/cap conflicts give HTTP 409
`points_redemption_conflict`. No fallback to v2 for positive requests.

`POST /api/public/pos/orders/:id/returns/preview` retains its existing request body
and adds integer `data.points_restored` plus `data.lines[].points_restored` (zero for
legacy orders). Refund amounts remain yuan. For points orders the preview reads the
stored net line totals, allocated points and all prior order-scoped return quantities,
using the same cumulative floor differences as the refund transaction. It includes
`refunded` and other non-rejected states, and also includes previously completed
returns even if later marked rejected. It rejects excessive remaining quantities
and duplicate line requests. No current conversion rule or membership entitlement
is needed to preview a historical refund. Zero-points orders preserve the existing
independent rounding and quantity behavior without querying return history.

The preview is advisory, not a reservation: concurrent returns can change the
remaining entitlement before submission. Display the actual `points_restored` and
refund amount from completion, or refresh the preview if submission reports a conflict.

## Activation

No conversion rate exists in the inspected membership migrations. Do not infer one
from the cap, earning multiplier, points balance or client defaults.

After an authorized migration rollout, the membership policy owner must approve and
configure `commerce_membership_plans.points_redemption_points_per_unit` (positive
whole points) and `points_redemption_unit_fen` (positive whole fen), then explicitly
set `points_redemption_enabled=true` and update `policy_version`. All new columns
default to disabled/null. Reuse the existing `points_redemption_cap_rate`; do not
raise a zero-cap free plan as a side effect. Active, unexpired entitlements determine
the plan, falling back to the active free plan, not the wallet's cached member label.

The cap is conservatively applied to eligible owned merchandise remaining after
other discounts. Excluded/consigned goods cannot fund a points discount; at least
one fen must remain payable. Disabling rules does not prevent historical refunds.

Before activation, verify the cash-only limitation in all clients and run a real
multi-session PostgreSQL concurrency test in an isolated staging database.

## Uncertain Sale Recovery

`POST /api/public/pos/sales/recover/cancel` accepts exactly:

```json
{"shift_id":"original-shift-uuid","client_op_id":"original-operation-id"}
```

Only HTTP 200 with `ok:true` and one of the following validated results permits
clearing a local pending-sale record:

```ts
type Resolution = {
  status: "cancelled";
  client_op_id: string;
  order: null;
} | {
  status: "completed";
  client_op_id: string;
  order: {
    order_id: string;
    order_no: string;
    subtotal: number;
    discount_total: number;
    total_amount: number; // All three monetary fields are yuan.
    points_redemption: Record<string, unknown> | null;
  };
};
// HTTP body: { ok: true, data: Resolution }
```

`completed` returns the existing order: show it and load its receipt, never submit
a replacement sale. `cancelled` means the server committed a permanent operation
tombstone, so a late sale using this ID can no longer complete through either v2 or
v3. Subsequent `/sales` submissions return HTTP 409 `sale_operation_cancelled`.
An intentional replacement sale must use a new operation ID. This is not a refund,
cash hand-back, or WeChat/Alipay cancellation; any funds already collected still
require reconciliation. This endpoint resolves direct `/sales` submissions, not the
native asynchronous payment-attempt lifecycle.

Both sale and recovery take the transaction advisory lock for
`hashtextextended('pos-sale:' || client_op_id, 0)`. Recovery waits for an in-flight
sale, checks the original shift/operator and either returns its committed order or
inserts a tombstone in the same transaction. Both entry points require READ COMMITTED
snapshots and reject other isolation levels rather than read a stale cancellation state.
The tombstone is never automatically expired or deleted. Legacy core sale functions
are revoked from runtime roles so they cannot bypass the fence. Rollout must apply
the complete migration atomically, including v2/v3 wrappers and function grants.

Authentication uses the original shift's location and its original employee; even
a manager cannot cancel someone else's operation through this endpoint. Closed
shifts may still be resolved. Missing permissions give 401/403, a missing original
shift gives 404 `shift_not_found`, and a cross-shift/employee operation collision
gives 409 `idempotency_conflict`. Missing migration/RPC or any uncertain backend
result gives 503 `sale_recovery_unavailable`. All failures, malformed results and
lost responses must retain the local record. Retry this endpoint with the same
shift/op; never use a lookup-only fallback. Ordinary zero-point v2 sales continue
to work without the migration, but safe cancellation deliberately does not.

## Transaction And Refund Semantics

The v3 wrapper serializes client operation IDs, checks replay ownership/request data,
locks the shift and wallet, locks SKU prices, and invokes the existing stock/payment
sale RPC. Wallet debit, ledger, order, net item amounts and receipt updates commit or
roll back together. v2 becomes a zero-points compatibility wrapper after migration,
preventing a replay from rewriting a points order. Legacy implementation functions
are not executable by API roles or service_role; only the definer wrappers call them.

Discount fen and points are allocated across eligible lines using cumulative floors.
Cash returns use cumulative net line amounts, not original prices; a final return
restores all originally redeemed points without creating extra cash value. Order,
shift and wallet locks serialize returns; replay never adds another credit. Failed
return/ledger writes roll back stock, refund and points together. Restoration follows
the existing cash `pos_complete_return` completion event, not an external provider.
Already completed return quantities remain counted after subsequent administrative
status changes, including `refunded`, so a status transition cannot reopen redemption.

## Local Verification

```sh
POINTS_PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js \
  node --experimental-strip-types --test src/lib/pos/points-policy.test.ts \
  src/lib/pos/points-sql.test.ts src/lib/pos/points-routes-contract.test.ts \
  src/lib/pos/points-return-preview.test.ts src/lib/pos/sale-recovery-sql.test.ts \
  src/server/pos-sale-recovery.test.ts
```

The module override is optional when project dependencies include PGlite. Tests load
the actual pre-existing discount, latest POS sale and return functions against a
minimal isolated schema. Inventory movement is a fixture stub; production inventory
triggers and integrations are not reproduced. Coverage includes decimal rounding,
disabled defaults, policy caps, balance, idempotency, noncash rejection, stock failure,
late ledger failure rollback, refund rollback, mixed eligibility, split-refund
conservation, frozen rules and function privileges. Return-preview tests additionally
compare every preview with the actual refund RPC across three split returns, changing
each preceding return to `refunded`; both paths produce 9.67/9.68/9.68 yuan and 1/2/2
points, then reject any further quantity. Legacy preview rounding is tested separately.
Sequential competing purchases
are tested; PGlite uses one serialized connection, so this is not evidence of genuine
multi-session concurrency. No production or real-device acceptance is claimed.

Recovery SQL tests cover cancellation followed by late v2/v3 sales, sale-before-cancel
for both points modes, repeated resolution, closed shifts, ownership conflicts,
rollback and role grants. Route tests bundle the real request schema and POS auth
logic with a stubbed database transport, including staff/store permissions, absent
migration and malformed RPC output. These do not replace a two-session PostgreSQL
race test or an external payment-provider reconciliation test.
