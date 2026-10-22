/**
 * 有赞总部 SPU 写后回读：spu.update 成功后关系编码（spu_code/sku_code）可能短暂不可见，
 * 立即 spu.query 会返回 null。这里做有限预算的延迟重读（0/1s/2s/4s，共 4 次约 7s），
 * 仍读不到则返回 null，由调用方按永久错误抛出（不重试、不重建，避免重复 SPU）。
 */
export async function readAfterHqUpdate<T>(
  read: () => Promise<T | null>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T | null> {
  for (const wait of [0, 1000, 2000, 4000]) {
    if (wait) await sleep(wait);
    const identity = await read();
    if (identity !== null) return identity;
  }
  return null;
}
