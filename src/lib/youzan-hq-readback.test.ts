import assert from "node:assert/strict";
import { test } from "node:test";
import { readAfterHqUpdate } from "./youzan-hq-readback.ts";

test("写后短暂不可见：迟两次可见仍返回正确原 id", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await readAfterHqUpdate(
    async () => {
      calls += 1;
      return calls < 3 ? null : { spuId: 6537375722, skuId: 543077538 };
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  assert.deepEqual(result, { spuId: 6537375722, skuId: 543077538 });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("有限预算：4 次（0/1/2/4s）后仍不可见返回 null，由调用方永久失败", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await readAfterHqUpdate(
    async () => {
      calls += 1;
      return null;
    },
    async (ms) => {
      sleeps.push(ms);
    },
  );
  assert.equal(result, null);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 7000);
});

test("读异常立即抛出，不再重试", async () => {
  let calls = 0;
  await assert.rejects(
    readAfterHqUpdate(
      async () => {
        calls += 1;
        throw new Error("spu.query failed");
      },
      async () => {},
    ),
    /spu\.query failed/,
  );
  assert.equal(calls, 1);
});

test("立即成功零等待", async () => {
  const sleeps: number[] = [];
  const result = await readAfterHqUpdate(
    async () => ({ spuId: 1 }),
    async (ms) => {
      sleeps.push(ms);
    },
  );
  assert.deepEqual(result, { spuId: 1 });
  assert.deepEqual(sleeps, []);
});
