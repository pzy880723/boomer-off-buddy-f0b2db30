import { describe, expect, test } from "bun:test";
import { readAfterHqUpdate } from "./youzan-hq-readback";

describe("readAfterHqUpdate", () => {
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
    expect(result).toEqual({ spuId: 6537375722, skuId: 543077538 });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
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
    expect(result).toBeNull();
    expect(calls).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(7000);
  });

  test("读异常立即抛出，不再重试", async () => {
    let calls = 0;
    await expect(
      readAfterHqUpdate(
        async () => {
          calls += 1;
          throw new Error("spu.query failed");
        },
        async () => {},
      ),
    ).rejects.toThrow("spu.query failed");
    expect(calls).toBe(1);
  });

  test("立即成功零等待", async () => {
    const sleeps: number[] = [];
    const result = await readAfterHqUpdate(
      async () => ({ spuId: 1 }),
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(result).toEqual({ spuId: 1 });
    expect(sleeps).toEqual([]);
  });
});
