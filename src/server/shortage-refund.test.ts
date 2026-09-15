import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmShortageRefund,
  getShortageCase,
  listShortageCases,
  type ConfirmOutcome,
  type ShortageDbRow,
  type ShortageDeps,
} from "./shortage-refund.server";

const baseRow: ShortageDbRow = {
  id: "s1",
  order_id: "o1",
  quantity: 2,
  reason: "缺货",
  status: "pending_customer",
  refund_state: "awaiting_confirmation",
  product_name: "旧书",
  image_ref: "sku-listing/a.jpg",
  location_id: "L1",
  order_item_id: "oi1",
  fulfillment_item_id: "fi1",
  refund_intent_id: null,
  quote_version: "v1",
  refund_goods_fen: 1000,
  refund_shipping_fen: 0,
  refund_total_fen: 1000,
  created_at: "2026-09-13T00:00:00Z",
  customer_responded_at: null,
  refund_requested_at: null,
  refunded_at: null,
};

function makeDeps(overrides: Partial<ShortageDeps> = {}, rows: ShortageDbRow[] = [baseRow]): ShortageDeps {
  return {
    fetchOrders: async (customerId, orderId) =>
      customerId === "c1" && (!orderId || orderId === "o1")
        ? [{ id: "o1", order_no: "BO1" }]
        : [],
    fetchShortages: async (orderIds, shortageId) =>
      rows.filter((r) => orderIds.includes(r.order_id ?? "") && (!shortageId || r.id === shortageId)),
    fetchStoreNames: async () => new Map([["L1", "温州店"]]),
    fetchIntentShortageIds: async () => new Set<string>(),
    signThumbnails: async (refs) => refs.map((r) => (r ? `signed:${r}` : null)),
    ensureQuote: async (row) => row,
    confirmRefund: async (): Promise<ConfirmOutcome> => ({ kind: "ok", row: baseRow, replayed: false }),
    ...overrides,
  };
}

test("list returns contract cases with derivative thumbnails and store names", async () => {
  const items = await listShortageCases(makeDeps(), "c1", "o1");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.order_no, "BO1");
  assert.equal(items[0]!.store_name, "温州店");
  assert.equal(items[0]!.thumbnail_url, "signed:sku-listing/a.jpg");
  assert.equal(items[0]!.can_confirm, true);
});

test("another customer's shortage is invisible", async () => {
  assert.deepEqual(await listShortageCases(makeDeps(), "c2"), []);
  assert.equal(await getShortageCase(makeDeps(), "c2", "s1"), null);
});

test("an existing refund intent disables can_confirm", async () => {
  const deps = makeDeps({ fetchIntentShortageIds: async () => new Set(["s1"]) });
  const found = await getShortageCase(deps, "c1", "s1");
  assert.equal(found?.can_confirm, false);
});

test("stale quote version returns 409 QUOTE_CHANGED", async () => {
  const deps = makeDeps({ confirmRefund: async () => ({ kind: "quote_changed" }) });
  const res = await confirmShortageRefund(deps, {
    customerId: "c1",
    shortageId: "s1",
    quoteVersion: "old",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok === false && res.body.code, "QUOTE_CHANGED");
});

test("confirm passes the documented idempotency key and returns the fresh case", async () => {
  const seen: string[] = [];
  const queued: ShortageDbRow = { ...baseRow, status: "customer_accepted", refund_state: "queued" };
  const deps = makeDeps(
    {
      confirmRefund: async (input) => {
        seen.push(input.idempotencyKey);
        return { kind: "ok", row: queued, replayed: false };
      },
      fetchIntentShortageIds: async () => new Set(["s1"]),
    },
    [queued],
  );
  const res = await confirmShortageRefund(deps, {
    customerId: "c1",
    shortageId: "s1",
    quoteVersion: "v1",
  });
  assert.deepEqual(seen, ["shortage:s1:v1"]);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok === true && res.body.data.refund_state, "queued");
  assert.equal(res.body.ok === true && res.body.data.can_confirm, false);
});

test("repeated confirm replays the same intent state, never a second refund", async () => {
  const queued: ShortageDbRow = { ...baseRow, status: "customer_accepted", refund_state: "queued" };
  let calls = 0;
  const deps = makeDeps(
    {
      confirmRefund: async () => {
        calls += 1;
        return { kind: "ok", row: queued, replayed: true };
      },
      fetchIntentShortageIds: async () => new Set(["s1"]),
    },
    [queued],
  );
  const first = await confirmShortageRefund(deps, { customerId: "c1", shortageId: "s1", quoteVersion: "v1" });
  const second = await confirmShortageRefund(deps, { customerId: "c1", shortageId: "s1", quoteVersion: "v1" });
  assert.equal(calls, 2);
  assert.deepEqual(first.body, second.body);
});

test("a shortage that is not the caller's returns 404 from confirm", async () => {
  const deps = makeDeps({ confirmRefund: async () => ({ kind: "not_found" }) });
  const res = await confirmShortageRefund(deps, { customerId: "c9", shortageId: "s1", quoteVersion: "v1" });
  assert.equal(res.status, 404);
});
