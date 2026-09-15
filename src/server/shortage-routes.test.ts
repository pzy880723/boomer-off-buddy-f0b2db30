import test from "node:test";
import assert from "node:assert/strict";
import { handleConfirmRefund, handleRespond } from "./shortage-routes.server";
import type { ShortageDbRow, ShortageDeps } from "./shortage-refund.server";

const row: ShortageDbRow = {
  id: "s1",
  order_id: "o1",
  order_no: "BO1",
  quantity: 1,
  reason: "缺货",
  status: "pending_customer",
  refund_state: "awaiting_confirmation",
  product_name: "旧书",
  image_ref: null,
  location_id: "L1",
  order_item_id: "oi1",
  fulfillment_item_id: "fi1",
  refund_intent_id: null,
  quote_version: "v1",
  refund_goods_fen: 1000,
  refund_shipping_fen: 990,
  refund_total_fen: 1990,
  created_at: "2026-09-13T00:00:00Z",
  customer_responded_at: null,
  refund_requested_at: null,
  refunded_at: null,
};

function env(enabled: boolean, onConfirm?: () => void) {
  const writes: string[] = [];
  const kicks: string[] = [];
  const deps: ShortageDeps = {
    fetchShortagePage: async () => ({ rows: [row], nextCursor: null }),
    fetchShortageById: async (_c, id) => (id === row.id ? row : null),
    countPendingShortages: async () => 1,
    fetchStoreNames: async () => new Map(),
    fetchIntentShortageIds: async () => new Set<string>(),
    signThumbnails: async (refs) => refs.map(() => null),
    ensureQuote: async (r) => r,
    refundExecutionEnabled: () => enabled,
    confirmRefund: async (input) => {
      writes.push(input.idempotencyKey);
      onConfirm?.();
      return { kind: "ok", row, replayed: false };
    },
  };
  return {
    writes,
    kicks,
    routeEnv: {
      deps,
      kick: async (id: string) => {
        kicks.push(id);
        return { executed: enabled };
      },
    },
  };
}

test("worker 未开启：confirm-refund 路由返回 503 且没有任何写入 / 执行", async () => {
  const e = env(false);
  const res = await handleConfirmRefund(e.routeEnv, {
    customerId: "c1",
    shortageId: "s1",
    quoteVersion: "v1",
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok === false && res.body.code, "refund_worker_disabled");
  assert.deepEqual(e.writes, []);
  assert.deepEqual(e.kicks, []);
});

test("worker 未开启：旧 respond 路由同样 503，不改状态", async () => {
  const e = env(false);
  const res = await handleRespond(e.routeEnv, { customerId: "c1", shortageId: "s1" });
  assert.equal(res.status, 503);
  assert.deepEqual(e.writes, []);
});

test("worker 未开启：详情 DTO can_confirm=false 且原因明确", async () => {
  const e = env(false);
  const res = await handleRespond(e.routeEnv, { customerId: "c1", shortageId: "s1" });
  assert.equal(res.status, 503);
  const detail = await (
    await import("./shortage-refund.server")
  ).getShortageCase(e.routeEnv.deps, "c1", "s1");
  assert.equal(detail?.can_confirm, false);
  assert.equal(detail?.can_confirm_reason, "refund_worker_disabled");
});

test("worker 已开启：确认写入一次并立即触发执行", async () => {
  const e = env(true);
  const res = await handleConfirmRefund(e.routeEnv, {
    customerId: "c1",
    shortageId: "s1",
    quoteVersion: "v1",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(e.writes, ["shortage:s1:v1"]);
  assert.deepEqual(e.kicks, ["s1"]);
});

test("非本人缺货：respond 路由 404，不泄露存在性", async () => {
  const e = env(true);
  const res = await handleRespond(e.routeEnv, { customerId: "c1", shortageId: "other" });
  assert.equal(res.status, 404);
  assert.deepEqual(e.writes, []);
});
