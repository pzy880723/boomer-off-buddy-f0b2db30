import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commitOrderPage, type OrderPageEntry } from "./youzan-order-page";

const mapped: OrderPageEntry<{ tid: string }>[] = [
  { row: { kdt_id: 1, tid: "A" }, trade: { tid: "A" }, targetShopId: "s", status: "TRADE_SUCCESS" },
  { row: { kdt_id: 1, tid: "B" }, trade: { tid: "B" }, targetShopId: "s", status: "WAIT_SELLER_SEND_GOODS" },
  { row: { kdt_id: 1, tid: "C" }, trade: { tid: "C" }, targetShopId: "s", status: "TRADE_CLOSED" },
];
const okSale = async () => ({ processed: 1, idempotent: 0, unmatched: 0, failed: 0 });

test("队列切片：只走 commitRows 原子提交，绝不调用库存对账或普通 upsert", async () => {
  const commits: unknown[][] = [];
  let sales = 0;
  let upserts = 0;
  const r = await commitOrderPage({
    mapped,
    commitRows: async (rows) => {
      commits.push(rows);
      return ["1:A", "1:B", "1:C"];
    },
    upsertRows: async () => {
      upserts++;
    },
    processSale: async () => {
      sales++;
      return okSale();
    },
  });
  assert.equal(commits.length, 1, "整页一次性提交");
  assert.deepEqual(commits[0], mapped.map((m) => m.row));
  assert.equal(sales, 0);
  assert.equal(upserts, 0);
  assert.deepEqual(r, { upserted: 3, processed: 0, idempotent: 0, unmatched: 0, failed: 0 });
});

test("队列切片：租约/提交失败直接抛出，不做部分处理", async () => {
  let sales = 0;
  await assert.rejects(
    commitOrderPage({
      mapped,
      commitRows: async () => {
        throw new Error("order_batch_failed: lease_lost");
      },
      upsertRows: async () => {},
      processSale: async () => {
        sales++;
        return okSale();
      },
    }),
    /lease_lost/,
  );
  assert.equal(sales, 0);
});

test("手动全同步：保持原行为，upsert 后对售出状态调用库存对账，失败计数不中断", async () => {
  const seen: string[] = [];
  let upserts = 0;
  const r = await commitOrderPage({
    mapped,
    upsertRows: async () => {
      upserts++;
    },
    processSale: async (e) => {
      seen.push(e.trade.tid);
      if (e.trade.tid === "B") throw new Error("boom");
      return okSale();
    },
  });
  assert.equal(upserts, 1);
  assert.ok(!seen.includes("C"), "交易关闭不做销售处理");
  assert.ok(seen.includes("A"));
  assert.equal(r.upserted, 3);
  assert.equal(r.failed, 1);
});

test("源码护栏：订单分页循环经 commitOrderPage，且队列入口传入 commitRows", () => {
  const src = readFileSync(new URL("./youzan.functions.ts", import.meta.url), "utf8");
  assert.match(src, /commitOrderPage\(\{[\s\S]*?commitRows: slice\?\.commitRows/);
  assert.match(src, /export async function runOrdersSyncSlice[\s\S]*?commitRows: opts\.commitRows/);
  // 订单循环里不再直接调用库存对账（只经 commitOrderPage 的 processSale 回调）
  const loop = src.slice(src.indexOf("async function runOrdersSyncForShop("), src.indexOf("export async function runOrdersSyncSlice"));
  assert.equal((loop.match(/processYouzanSale\(/g) ?? []).length, 1);
  assert.match(loop, /processSale: \(entry\) =>\s*processYouzanSale\(/);
});
