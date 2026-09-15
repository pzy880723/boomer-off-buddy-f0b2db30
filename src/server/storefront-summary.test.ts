import test from "node:test";
import assert from "node:assert/strict";
import {
  SUMMARY_CACHE_TTL_MS,
  createSummaryCache,
  type SummaryDeps,
} from "./storefront-summary.server";

function deps(overrides: Partial<SummaryDeps> = {}): SummaryDeps {
  return {
    afterSales: async () => ({ pending_count: 2, pending_shortage_count: 2 }),
    orderCounts: async () => ({
      pending_payment: 1,
      awaiting_shipment: 3,
      awaiting_receipt: 0,
      completed: 7,
    }),
    ...overrides,
  };
}

test("汇总同时返回售后待处理与四档订单角标，全部非负整数", async () => {
  const cache = createSummaryCache();
  const data = await cache.get("c1", deps());
  assert.deepEqual(data, {
    pending_count: 2,
    pending_shortage_count: 2,
    order_counts: { pending_payment: 1, awaiting_shipment: 3, awaiting_receipt: 0, completed: 7 },
  });
  for (const value of Object.values(data.order_counts)) {
    assert.ok(Number.isInteger(value) && value >= 0);
  }
});

test("30 秒缓存命中，不重复查询；过期后重新取数", async () => {
  let now = 1_000_000;
  const cache = createSummaryCache(() => now);
  let calls = 0;
  const d = deps({
    orderCounts: async () => {
      calls += 1;
      return { pending_payment: calls, awaiting_shipment: 0, awaiting_receipt: 0, completed: 0 };
    },
  });
  await cache.get("c1", d);
  await cache.get("c1", d);
  assert.equal(calls, 1);
  now += SUMMARY_CACHE_TTL_MS + 1;
  await cache.get("c1", d);
  assert.equal(calls, 2);
});

test("缓存按账号隔离，绝不把他人计数返回给另一个客户", async () => {
  const cache = createSummaryCache();
  const byCustomer: Record<string, number> = { c1: 1, c2: 9 };
  const d = deps({
    orderCounts: async (customerId) => ({
      pending_payment: byCustomer[customerId] ?? 0,
      awaiting_shipment: 0,
      awaiting_receipt: 0,
      completed: 0,
    }),
  });
  const a = await cache.get("c1", d);
  const b = await cache.get("c2", d);
  assert.equal(a.order_counts.pending_payment, 1);
  assert.equal(b.order_counts.pending_payment, 9);
});

test("汇总不查询积分/优惠券：只调用售后与订单计数两个依赖", async () => {
  const called: string[] = [];
  const cache = createSummaryCache();
  await cache.get("c1", {
    afterSales: async () => {
      called.push("afterSales");
      return { pending_count: 0, pending_shortage_count: 0 };
    },
    orderCounts: async () => {
      called.push("orderCounts");
      return { pending_payment: 0, awaiting_shipment: 0, awaiting_receipt: 0, completed: 0 };
    },
  });
  assert.deepEqual(called.sort(), ["afterSales", "orderCounts"]);
});

test("订单计数失败不拖垮售后待办：缺失时省略 order_counts，不伪造为 0", async () => {
  const cache = createSummaryCache();
  const data = await cache.get(
    "c1",
    deps({
      orderCounts: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal(data.pending_count, 2);
  assert.equal("order_counts" in data, false);
});

test("失败结果不写入缓存，下次仍会重试", async () => {
  const cache = createSummaryCache();
  let calls = 0;
  const d = deps({
    orderCounts: async () => {
      calls += 1;
      if (calls === 1) throw new Error("db down");
      return { pending_payment: 4, awaiting_shipment: 0, awaiting_receipt: 0, completed: 0 };
    },
  });
  await cache.get("c1", d);
  const second = await cache.get("c1", d);
  assert.equal(calls, 2);
  assert.equal(second.order_counts?.pending_payment, 4);
});
