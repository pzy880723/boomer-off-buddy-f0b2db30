import test from "node:test";
import assert from "node:assert/strict";
import {
  SHORTAGE_PAGE_SIZE,
  confirmShortageRefund,
  getAfterSalesSummary,
  getShortageCase,
  listShortageCases,
  type ConfirmOutcome,
  type ShortageDbRow,
  type ShortageDeps,
} from "./shortage-refund.server";

const baseRow: ShortageDbRow = {
  id: "s1",
  order_id: "o1",
  order_no: "BO1",
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

/** 内存「数据库」：按 customer 归属过滤 + 键集分页，模拟真实取数层语义。 */
function makeDeps(overrides: Partial<ShortageDeps> = {}, rows: ShortageDbRow[] = [baseRow]): ShortageDeps {
  const owned = (customerId: string) => (customerId === "c1" ? rows : []);
  return {
    async fetchShortagePage(customerId, { orderId, cursor, pageSize }) {
      let all = owned(customerId).filter((r) => !orderId || r.order_id === orderId);
      all = [...all].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      if (cursor) all = all.filter((r) => r.created_at < cursor);
      const page = all.slice(0, pageSize);
      const nextCursor = page.length >= pageSize ? (page[page.length - 1]!.created_at ?? null) : null;
      return { rows: page, nextCursor };
    },
    async fetchShortageById(customerId, shortageId) {
      return owned(customerId).find((r) => r.id === shortageId) ?? null;
    },
    async countPendingShortages(customerId) {
      return owned(customerId).filter((r) => r.status === "pending_customer").length;
    },
    fetchStoreNames: async () => new Map([["L1", "温州店"]]),
    fetchIntentShortageIds: async () => new Set<string>(),
    signThumbnails: async (refs) => refs.map((r) => (r ? `signed:${r}` : null)),
    ensureQuote: async (row) => row,
    refundExecutionEnabled: () => true,
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
  assert.equal(items[0]!.can_confirm_reason, null);
});

test("超过一页（>100 / >200 条）的缺货必须完整可达，不能静默截断", async () => {
  const many: ShortageDbRow[] = Array.from({ length: SHORTAGE_PAGE_SIZE * 2 + 7 }, (_, i) => ({
    ...baseRow,
    id: `s${i}`,
    created_at: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(),
  }));
  const items = await listShortageCases(makeDeps({}, many), "c1");
  assert.equal(items.length, many.length);
  const summary = await getAfterSalesSummary(makeDeps({}, many), "c1");
  assert.equal(summary.pending_count, many.length);
});

test("老单详情：直接按 shortage id + 归属读取，不扫描最近订单", async () => {
  const old: ShortageDbRow = { ...baseRow, id: "old1", created_at: "2019-01-01T00:00:00Z" };
  let pages = 0;
  const deps = makeDeps(
    {
      fetchShortagePage: async () => {
        pages += 1;
        return { rows: [], nextCursor: null };
      },
    },
    [old],
  );
  const found = await getShortageCase(deps, "c1", "old1");
  assert.equal(found?.id, "old1");
  assert.equal(pages, 0, "详情不得依赖订单/缺货列表分页");
});

test("another customer's shortage is invisible", async () => {
  assert.deepEqual(await listShortageCases(makeDeps(), "c2"), []);
  assert.equal(await getShortageCase(makeDeps(), "c2", "s1"), null);
});

test("an existing refund intent disables can_confirm", async () => {
  const deps = makeDeps({ fetchIntentShortageIds: async () => new Set(["s1"]) });
  const found = await getShortageCase(deps, "c1", "s1");
  assert.equal(found?.can_confirm, false);
  assert.equal(found?.can_confirm_reason, "already_requested");
});

test("退款执行未开启：can_confirm=false 且给出原因", async () => {
  const deps = makeDeps({ refundExecutionEnabled: () => false });
  const found = await getShortageCase(deps, "c1", "s1");
  assert.equal(found?.can_confirm, false);
  assert.equal(found?.can_confirm_reason, "refund_worker_disabled");
});

test("退款执行未开启：确认一律 503，且不发生任何确认写入", async () => {
  let writes = 0;
  const deps = makeDeps({
    refundExecutionEnabled: () => false,
    confirmRefund: async () => {
      writes += 1;
      return { kind: "ok", row: baseRow, replayed: false };
    },
  });
  const res = await confirmShortageRefund(deps, {
    customerId: "c1",
    shortageId: "s1",
    quoteVersion: "v1",
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok === false && res.body.code, "refund_worker_disabled");
  assert.equal(writes, 0);
});

test("安全关键读取失败必须抛错，绝不当成 0 / 无退款", async () => {
  const boom = async () => {
    throw new Error("refund_intent_read_failed: network");
  };
  await assert.rejects(
    () => listShortageCases(makeDeps({ fetchIntentShortageIds: boom as never }), "c1"),
    /refund_intent_read_failed/,
  );
  await assert.rejects(
    () =>
      getAfterSalesSummary(
        makeDeps({
          countPendingShortages: async () => {
            throw new Error("shortage_count_failed");
          },
        }),
        "c1",
      ),
    /shortage_count_failed/,
  );
});

test("汇总是纯计数：既不补报价也不签图", async () => {
  let quoted = 0;
  let signed = 0;
  const deps = makeDeps({
    ensureQuote: async (row) => {
      quoted += 1;
      return row;
    },
    signThumbnails: async (refs) => {
      signed += 1;
      return refs.map(() => null);
    },
  });
  const summary = await getAfterSalesSummary(deps, "c1");
  assert.deepEqual(summary, { pending_count: 1, pending_shortage_count: 1 });
  assert.equal(quoted, 0);
  assert.equal(signed, 0);
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

test("历史缺货（无报价、refund_pending）读时补真实报价后成为可确认待办", async () => {
  const legacy: ShortageDbRow = {
    ...baseRow,
    id: "legacy1",
    refund_state: "refund_pending",
    quote_version: null,
    refund_goods_fen: null as unknown as number,
    refund_shipping_fen: null as unknown as number,
    refund_total_fen: null as unknown as number,
  };
  const quoted: ShortageDbRow = {
    ...legacy,
    refund_state: "awaiting_confirmation",
    quote_version: "v-legacy",
    refund_goods_fen: 1,
    refund_shipping_fen: 990,
    refund_total_fen: 991,
  };
  const deps = makeDeps({ ensureQuote: async () => quoted }, [legacy]);
  const items = await listShortageCases(deps, "c1");
  assert.equal(items[0]!.can_confirm, true);
  // 运费 9.90 元必须退：整组未发货且整行缺货
  assert.equal(items[0]!.refund_shipping_fen, 990);
  assert.equal(items[0]!.refund_total_fen, 991);
});

test("历史缺货无法安全报价时明确人工处理，不编造金额", async () => {
  const legacy: ShortageDbRow = { ...baseRow, id: "legacy2", refund_state: "refund_pending", quote_version: null };
  const manual: ShortageDbRow = {
    ...legacy,
    refund_state: "manual_review",
    quote_version: null,
    refund_goods_fen: 0,
    refund_shipping_fen: 0,
    refund_total_fen: 0,
  };
  const deps = makeDeps({ ensureQuote: async () => manual }, [legacy]);
  const found = await getShortageCase(deps, "c1", "legacy2");
  assert.equal(found?.can_confirm, false);
  assert.equal(found?.refund_total_fen, 0);
  assert.equal(found?.refund_state, "manual_review");
});

test("跨客户：他人缺货既不补报价也不出现在待办汇总", async () => {
  let quoted = 0;
  const deps = makeDeps({
    ensureQuote: async (row) => {
      quoted += 1;
      return row;
    },
  });
  assert.deepEqual(await getAfterSalesSummary(deps, "c2"), { pending_count: 0, pending_shortage_count: 0 });
  assert.equal(quoted, 0);
});
