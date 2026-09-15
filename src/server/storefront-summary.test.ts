import test from "node:test";
import assert from "node:assert/strict";
import { loadStorefrontSummary, type SummaryDeps } from "./storefront-summary.server";

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
  const data = await loadStorefrontSummary("c1", deps());
  assert.deepEqual(data, {
    pending_count: 2,
    pending_shortage_count: 2,
    order_counts: { pending_payment: 1, awaiting_shipment: 3, awaiting_receipt: 0, completed: 7 },
  });
  for (const value of Object.values(data.order_counts!)) {
    assert.ok(Number.isInteger(value) && value >= 0);
  }
});

test("没有服务端缓存：状态变更后下一次请求立刻反映新数值", async () => {
  let pending = 2;
  const d = deps({ afterSales: async () => ({ pending_count: pending, pending_shortage_count: pending }) });
  assert.equal((await loadStorefrontSummary("c1", d)).pending_count, 2);
  pending = 0; // 客户刚确认完退款
  assert.equal((await loadStorefrontSummary("c1", d)).pending_count, 0);
});

test("账号隔离：每次按传入 customer_id 取数，绝不返回他人计数", async () => {
  const byCustomer: Record<string, number> = { c1: 1, c2: 9 };
  const d = deps({
    afterSales: async (customerId) => ({
      pending_count: byCustomer[customerId] ?? 0,
      pending_shortage_count: byCustomer[customerId] ?? 0,
    }),
  });
  assert.equal((await loadStorefrontSummary("c1", d)).pending_count, 1);
  assert.equal((await loadStorefrontSummary("c2", d)).pending_count, 9);
});

test("订单计数失败时省略 order_counts，绝不伪造为 0", async () => {
  const data = await loadStorefrontSummary(
    "c1",
    deps({
      orderCounts: async () => {
        throw new Error("db down");
      },
    }),
  );
  assert.equal("order_counts" in data, false);
  assert.equal(data.pending_count, 2);
});

test("售后待办读取失败必须抛错（不能当成没有待办）", async () => {
  await assert.rejects(
    () =>
      loadStorefrontSummary(
        "c1",
        deps({
          afterSales: async () => {
            throw new Error("shortage_count_failed");
          },
        }),
      ),
    /shortage_count_failed/,
  );
});
