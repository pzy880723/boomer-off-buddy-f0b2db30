import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmIdempotencyKey,
  normalizeRefundState,
  toShortageCase,
  type ShortageRow,
} from "./case";

const row: ShortageRow = {
  id: "s1",
  order_id: "o1",
  quantity: 1,
  reason: "货架无货",
  status: "pending_customer",
  refund_state: "awaiting_confirmation",
  product_name: "旧书",
  quote_version: "abc",
  refund_goods_fen: 1000,
  refund_shipping_fen: 200,
  refund_total_fen: 1200,
  created_at: "2026-09-13T00:00:00Z",
  customer_responded_at: null,
  refund_requested_at: null,
  refunded_at: null,
};

const extra = {
  order_no: "BO1",
  store_name: "温州店",
  thumbnail_url: "https://x/render/image/sign/a.jpg",
  has_refund_intent: false,
  refund_execution_enabled: true,
};

test("legacy refund states fold into the v1 contract", () => {
  assert.equal(normalizeRefundState("refund_pending"), "manual_review");
  assert.equal(normalizeRefundState("refund_completed"), "succeeded");
  assert.equal(normalizeRefundState("not_required"), "manual_review");
  assert.equal(normalizeRefundState("queued"), "queued");
});

test("can_confirm is true only for an unclaimed, priced, awaiting case", () => {
  assert.equal(toShortageCase(row, extra).can_confirm, true);
  assert.equal(toShortageCase(row, { ...extra, has_refund_intent: true }).can_confirm, false);
  assert.equal(toShortageCase({ ...row, quote_version: null }, extra).can_confirm, false);
  assert.equal(toShortageCase({ ...row, refund_total_fen: 0 }, extra).can_confirm, false);
  assert.equal(toShortageCase({ ...row, refund_state: "queued" }, extra).can_confirm, false);
  assert.equal(toShortageCase({ ...row, status: "customer_accepted" }, extra).can_confirm, false);
});

test("case exposes only the contracted fields with integer fen and a derivative thumbnail", () => {
  const c = toShortageCase(row, extra);
  assert.deepEqual(Object.keys(c).sort(), [
    "can_confirm",
    "created_at",
    "customer_responded_at",
    "id",
    "order_id",
    "order_no",
    "product_name",
    "quantity",
    "quote_version",
    "reason",
    "refund_goods_fen",
    "refund_requested_at",
    "refund_shipping_fen",
    "refund_state",
    "refund_total_fen",
    "refunded_at",
    "status",
    "store_name",
    "thumbnail_url",
  ]);
  assert.equal(c.refund_total_fen, 1200);
  assert.equal(
    toShortageCase(row, { ...extra, thumbnail_url: null }).thumbnail_url,
    null,
    "转换失败必须是 null，不能回退原图",
  );
});

test("idempotency key matches the documented client contract", () => {
  assert.equal(confirmIdempotencyKey("s1", "abc"), "shortage:s1:abc");
});
