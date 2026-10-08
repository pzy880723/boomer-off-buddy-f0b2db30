import test from "node:test";
import assert from "node:assert/strict";
import {
  FANKUANG_BASKET_SIZE,
  FANKUANG_GIFT_PROBABILITY,
  GiftOrderFields,
  FlipRequest,
  SessionStartRequest,
  paidItemQuantity,
  validateGiftClaim,
  shanghaiBusinessDate,
  mapFankuangDbError,
} from "./fankuang-gift";

const uuid = () => crypto.randomUUID();

test("constants: 100 per basket, independent 1% per valid flip", () => {
  assert.equal(FANKUANG_BASKET_SIZE, 100);
  assert.equal(FANKUANG_GIFT_PROBABILITY, 0.01);
});

test("paid quantity counts every paid unit incl. same SKU multiples and listing_ids", () => {
  assert.equal(paidItemQuantity({ items: [{ listing_id: uuid(), quantity: 3 }, { listing_id: uuid(), quantity: 1 }] }), 4);
  assert.equal(paidItemQuantity({ listing_ids: [uuid(), uuid()] }), 2);
  assert.equal(paidItemQuantity({}), 0);
});

test("gift count must not exceed paid units nor won entitlements", () => {
  assert.equal(validateGiftClaim({ giftCount: 0, paidQuantity: 0, availableEntitlements: 0 }), null);
  assert.equal(validateGiftClaim({ giftCount: 2, paidQuantity: 2, availableEntitlements: 2 }), null);
  assert.equal(validateGiftClaim({ giftCount: 3, paidQuantity: 2, availableEntitlements: 5 }), "gift_exceeds_paid_items");
  assert.equal(validateGiftClaim({ giftCount: 2, paidQuantity: 5, availableEntitlements: 1 }), "gift_entitlement_unavailable");
  assert.equal(validateGiftClaim({ giftCount: -1, paidQuantity: 5, availableEntitlements: 1 }), "gift_count_invalid");
});

test("order gift fields: ids and count must agree; omission means no gifts", () => {
  const ids = [uuid(), uuid()];
  assert.deepEqual(GiftOrderFields.parse({}), {});
  assert.equal(GiftOrderFields.parse({ gift_entitlement_ids: ids, gift_count: 2 }).gift_count, 2);
  assert.equal(GiftOrderFields.safeParse({ gift_entitlement_ids: ids, gift_count: 1 }).success, false);
  assert.equal(GiftOrderFields.safeParse({ gift_entitlement_ids: [ids[0], ids[0]] }).success, false);
  assert.equal(GiftOrderFields.safeParse({ gift_count: 1.5 }).success, false);
});

test("flip/session requests require stable client op ids", () => {
  assert.equal(FlipRequest.safeParse({ session_id: uuid(), listing_id: uuid(), client_op_id: "op-12345678" }).success, true);
  assert.equal(FlipRequest.safeParse({ session_id: uuid(), listing_id: uuid(), client_op_id: "x" }).success, false);
  assert.equal(SessionStartRequest.safeParse({ client_op_id: "op-12345678" }).success, true);
});

test("business date rolls over at 00:00 Asia/Shanghai", () => {
  assert.equal(shanghaiBusinessDate(new Date("2026-10-08T15:59:59Z")), "2026-10-08");
  assert.equal(shanghaiBusinessDate(new Date("2026-10-08T16:00:00Z")), "2026-10-09");
});

test("db errors map to stable API codes", () => {
  assert.deepEqual(mapFankuangDbError("fankuang gift exceeds paid items"), { status: 422, code: "gift_exceeds_paid_items" });
  assert.deepEqual(mapFankuangDbError("fankuang gift entitlement unavailable"), { status: 409, code: "gift_entitlement_unavailable" });
  assert.deepEqual(mapFankuangDbError("fankuang gift sku not purchasable"), { status: 422, code: "gift_sku_not_purchasable" });
  assert.deepEqual(mapFankuangDbError("fankuang gift idempotency conflict"), { status: 409, code: "gift_idempotency_conflict" });
  assert.deepEqual(mapFankuangDbError("fankuang client op conflict"), { status: 409, code: "client_op_conflict" });
  assert.deepEqual(mapFankuangDbError("fankuang listing not in session"), { status: 422, code: "listing_not_in_session" });
  assert.deepEqual(mapFankuangDbError("fankuang session not found"), { status: 404, code: "session_not_found" });
  assert.deepEqual(mapFankuangDbError("fankuang basket empty"), { status: 404, code: "basket_empty" });
  assert.equal(mapFankuangDbError("something else"), null);
});

test("review 2026-10-08: new gift db errors map to stable API codes", () => {
  assert.deepEqual(mapFankuangDbError("fankuang gift sku invalid"), { status: 503, code: "gift_sku_invalid" });
  assert.deepEqual(mapFankuangDbError("fankuang gift requires paid order"), { status: 422, code: "gift_requires_paid_items" });
  assert.deepEqual(mapFankuangDbError("fankuang gift count mismatch"), { status: 400, code: "gift_invalid" });
  assert.deepEqual(mapFankuangDbError("fankuang missing create argument p_recipient_name"), { status: 500, code: "gift_checkout_misconfigured" });
  assert.deepEqual(mapFankuangDbError("fankuang create function overloaded commerce_create_ordinary_order"), { status: 500, code: "gift_checkout_misconfigured" });
});
