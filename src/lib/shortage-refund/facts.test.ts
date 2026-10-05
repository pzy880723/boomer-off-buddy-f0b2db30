import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeQuoteFromFacts,
  groupShippingReserved,
  isProcessedShortage,
  type QuoteFacts,
  type ShortageSiblingRow,
} from "./facts";

const ITEM_A = "11111111-1111-1111-1111-111111111111";
const ITEM_B = "22222222-2222-2222-2222-222222222222";
const LOC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function sibling(patch: Partial<ShortageSiblingRow>): ShortageSiblingRow {
  return {
    id: "s-x",
    order_item_id: ITEM_A,
    location_id: LOC,
    quantity: 1,
    status: "pending_customer",
    refund_state: "awaiting_confirmation",
    refund_intent_id: null,
    refund_shipping_fen: null,
    ...patch,
  };
}

/** 一单两行、同一门店组、实付 200 元含运费 10 元，有完整运费快照。 */
function baseFacts(patch: Partial<QuoteFacts> = {}): QuoteFacts {
  return {
    order: {
      total_amount: 200,
      shipping_fee: 10,
      courier_quote_snapshot: { groups: [{ location_id: LOC, shipping_fee_fen: 1000 }] },
    },
    items: [
      { id: ITEM_A, location_id: LOC, quantity: 1, line_total: 100 },
      { id: ITEM_B, location_id: LOC, quantity: 1, line_total: 90 },
    ],
    shippedLocationIds: new Set<string>(),
    refunds: [],
    intents: [],
    afterSaleItemById: new Map(),
    shortages: [],
    ...patch,
  };
}

test("缺运费快照：商品额为正也不可自助确认（报价必须带 can_confirm=false）", () => {
  const facts = baseFacts({
    order: { total_amount: 200, shipping_fee: 10, courier_quote_snapshot: null },
  });
  const quote = computeQuoteFromFacts(facts, {
    shortageId: null,
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  assert.ok(quote.refund_goods_fen > 0);
  assert.equal(quote.refund_shipping_fen, 0);
  assert.equal(quote.can_confirm, false);
  assert.ok(quote.blocked_reasons.includes("shipping_snapshot_unavailable"));
});

test("同组另一行仍待履约（兄弟缺货只是待客户确认）→ 两条缺货都不退整组运费", () => {
  const pendingSibling = sibling({ id: "s-b", order_item_id: ITEM_B });
  const facts = baseFacts({ shortages: [sibling({ id: "s-a" }), pendingSibling] });

  const quoteA = computeQuoteFromFacts(facts, {
    shortageId: "s-a",
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  const quoteB = computeQuoteFromFacts(facts, {
    shortageId: "s-b",
    orderItemId: ITEM_B,
    locationId: LOC,
    quantity: 1,
  });
  assert.equal(quoteA.refund_shipping_fen, 0);
  assert.equal(quoteB.refund_shipping_fen, 0);
  // 两条加起来不得超过实付
  assert.ok(quoteA.refund_total_fen + quoteB.refund_total_fen <= 20000);
});

test("同组唯一其余行已真正处理（已生成退款意图）→ 本次才退该组运费", () => {
  const processed = sibling({
    id: "s-b",
    order_item_id: ITEM_B,
    status: "customer_accepted",
    refund_state: "queued",
    refund_intent_id: "intent-1",
    refund_shipping_fen: 0,
  });
  const facts = baseFacts({ shortages: [sibling({ id: "s-a" }), processed] });
  const quote = computeQuoteFromFacts(facts, {
    shortageId: "s-a",
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  assert.equal(quote.refund_shipping_fen, 1000);
});

test("同组运费已被另一条已处理缺货预留 → 本次按 goods-only，且仍可确认", () => {
  const reserved = sibling({
    id: "s-b",
    order_item_id: ITEM_B,
    status: "customer_accepted",
    refund_state: "queued",
    refund_intent_id: "intent-1",
    refund_shipping_fen: 1000,
  });
  const facts = baseFacts({ shortages: [sibling({ id: "s-a" }), reserved] });
  assert.equal(
    groupShippingReserved(facts.shortages, {
      shortageId: "s-a",
      orderItemId: ITEM_A,
      locationId: LOC,
      quantity: 1,
    }),
    true,
  );
  const quote = computeQuoteFromFacts(facts, {
    shortageId: "s-a",
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  assert.equal(quote.refund_shipping_fen, 0);
  assert.ok(quote.refund_goods_fen > 0);
  assert.equal(quote.can_confirm, true);
});

test("同一商品行历史已退：商品级上限按真实已退扣减，不再写死 0", () => {
  const facts = baseFacts({
    refunds: [{ id: "r1", after_sale_id: "as1", status: "succeeded", amount_fen: 9000 }],
    afterSaleItemById: new Map([["as1", ITEM_A]]),
  });
  const quote = computeQuoteFromFacts(facts, {
    shortageId: null,
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  // ITEM_A 分摊 100/190 * 19000 = 10000 分，已退 9000 → 最多再退 1000
  assert.equal(quote.refund_goods_fen, 1000);
  assert.ok(quote.blocked_reasons.includes("item_refund_cap_reached"));
  assert.equal(quote.can_confirm, false);
});

test("退款意图已落成退款记录：不得把意图与退款各计一次", () => {
  const facts = baseFacts({
    refunds: [{ id: "r1", after_sale_id: "as1", status: "succeeded", amount_fen: 5000 }],
    intents: [
      { id: "i1", after_sale_id: "as1", refund_id: "r1", state: "succeeded", amount_fen: 5000 },
    ],
    afterSaleItemById: new Map([["as1", ITEM_B]]),
  });
  const quote = computeQuoteFromFacts(facts, {
    shortageId: null,
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  // 支付级已占 5000（不是 10000），10000 商品额 + 运费未占满，不触顶
  assert.ok(!quote.blocked_reasons.includes("payment_refund_cap_reached"));
});

test("已驳回/撤回的兄弟缺货既不算已处理，也不预留运费", () => {
  const withdrawn = sibling({
    id: "s-b",
    order_item_id: ITEM_B,
    status: "withdrawn",
    refund_state: "queued",
    refund_intent_id: "intent-x",
    refund_shipping_fen: 1000,
  });
  assert.equal(isProcessedShortage(withdrawn), false);
  const facts = baseFacts({ shortages: [sibling({ id: "s-a" }), withdrawn] });
  const quote = computeQuoteFromFacts(facts, {
    shortageId: "s-a",
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  // ITEM_B 仍待履约 → 不退运费
  assert.equal(quote.refund_shipping_fen, 0);
});

test("该组已发货 → 旧的含运费报价必须重算为 goods-only", () => {
  const facts = baseFacts({
    items: [{ id: ITEM_A, location_id: LOC, quantity: 1, line_total: 100 }],
    shippedLocationIds: new Set([LOC]),
  });
  const quote = computeQuoteFromFacts(facts, {
    shortageId: "s-a",
    orderItemId: ITEM_A,
    locationId: LOC,
    quantity: 1,
  });
  assert.equal(quote.refund_shipping_fen, 0);
  assert.ok(quote.refund_goods_fen > 0);
  assert.equal(quote.can_confirm, true);
});

/** 分批缺货：同一行 quantity=2 分两次各报 1。 */
function splitFacts(qty: number, lineTotal: number, total: number) {
  return baseFacts({
    order: {
      total_amount: total,
      shipping_fee: 10,
      courier_quote_snapshot: { groups: [{ location_id: LOC, shipping_fee_fen: 1000 }] },
    },
    items: [{ id: ITEM_A, location_id: LOC, quantity: qty, line_total: lineTotal }],
  });
}

test("分批缺货 qty=2 两次各 1：第二次（第一次已处理）退剩余商品额 + 整组运费", () => {
  const facts = splitFacts(2, 100, 110);
  const first = computeQuoteFromFacts(facts, { shortageId: "s1", orderItemId: ITEM_A, locationId: LOC, quantity: 1 });
  assert.equal(first.refund_goods_fen, 5000);
  assert.equal(first.refund_shipping_fen, 0);
  facts.shortages = [sibling({ id: "s1", quantity: 1, status: "customer_accepted", refund_intent_id: "i1", refund_state: "queued" })];
  facts.intents = [];
  const second = computeQuoteFromFacts(facts, { shortageId: "s2", orderItemId: ITEM_A, locationId: LOC, quantity: 1 });
  assert.equal(second.refund_goods_fen, 5000);
  assert.equal(second.refund_shipping_fen, 1000);
  assert.equal(second.can_confirm, true);
});

test("分批缺货 qty=3 不可整除：三次各 1 合计恰为行分摊额，不多退", () => {
  const facts = splitFacts(3, 1, 11); // 商品 100 分 → 34/33/33
  const got: number[] = [];
  for (const id of ["s1", "s2", "s3"]) {
    const q = computeQuoteFromFacts(facts, { shortageId: id, orderItemId: ITEM_A, locationId: LOC, quantity: 1 });
    got.push(q.refund_goods_fen);
    facts.shortages = [...facts.shortages, sibling({ id, quantity: 1, status: "customer_accepted", refund_intent_id: `i-${id}`, refund_state: "queued" })];
  }
  assert.deepEqual(got, [34, 33, 33]);
});

test("分批缺货：兄弟仅待客户确认不算已处理，第二次仍不退运费", () => {
  const facts = splitFacts(2, 100, 110);
  facts.shortages = [sibling({ id: "s1", quantity: 1 })];
  const q = computeQuoteFromFacts(facts, { shortageId: "s2", orderItemId: ITEM_A, locationId: LOC, quantity: 1 });
  assert.equal(q.refund_shipping_fen, 0);
});
