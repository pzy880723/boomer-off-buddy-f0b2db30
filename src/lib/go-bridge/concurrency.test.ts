import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllPages, mapLimit, sumYouzanPaid } from "./concurrency";

test("mapLimit 不超过并发上限且保持顺序", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
});

test("mapLimit 拒绝非法上限", async () => {
  await assert.rejects(() => mapLimit([1], 0, async (n) => n));
});

test("fetchAllPages 读取超过 1000 行不截断", async () => {
  const total = 2345;
  const calls: number[] = [];
  const rows = await fetchAllPages<number>(async (from, to) => {
    calls.push(from);
    const data = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) data.push(i);
    return { data, error: null };
  });
  assert.equal(rows.length, total);
  assert.deepEqual(calls, [0, 1000, 2000]);
});

test("fetchAllPages 任一页失败即抛错，不返回部分数据", async () => {
  await assert.rejects(
    () =>
      fetchAllPages<number>(async (from) =>
        from === 0
          ? { data: Array(1000).fill(1), error: null }
          : { data: null, error: { message: "boom" } },
      ),
    /boom/,
  );
});

test("sumYouzanPaid 整数分、去重、排除 TRADE_CLOSED", () => {
  const r = sumYouzanPaid([
    { tid: "a", status: "TRADE_SUCCESS", payment: "10.10", total_fee: null },
    { tid: "a", status: "TRADE_SUCCESS", payment: "10.10", total_fee: null },
    { tid: "b", status: "trade_closed", payment: 99, total_fee: null },
    { tid: "c", status: "WAIT_SELLER_SEND_GOODS", payment: null, total_fee: 0.2 },
  ]);
  assert.deepEqual(r, { fen: 1030, orders: 2 });
});

test("sumYouzanPaid 非法金额抛错不当 0", () => {
  assert.throws(() =>
    sumYouzanPaid([{ tid: "x", status: "TRADE_SUCCESS", payment: "abc", total_fee: null }]),
  );
});
