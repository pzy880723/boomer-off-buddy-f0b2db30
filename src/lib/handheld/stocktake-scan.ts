// 盘点扫描关联确认：只按“本次请求的 EPC 在数据库中已持久化的 stocktake_scans 行”计算结果。
// accepted = 已持久化且 sku_id 非空；unknown = 未持久化或 sku_id 为空（含 inv_epcs 存在但未绑 SKU）。
export function normalizeScanEpcs(epcs: readonly string[]): string[] {
  return Array.from(new Set(epcs.map((s) => s.trim()).filter(Boolean)));
}

export function classifyStocktakeScan(
  epcs: readonly string[],
  persisted: ReadonlyArray<{ epc: string; sku_id: string | null }>,
) {
  const byEpc = new Map(persisted.map((r) => [r.epc, r.sku_id]));
  const unknown = epcs.filter((epc) => !byEpc.get(epc));
  return {
    received: epcs.length,
    accepted: epcs.length - unknown.length,
    unknown_count: unknown.length,
    unknown,
  };
}

/** 旧记录 sku_id 为空、现已能关联的 EPC，按 SKU 分组以便只补空值（绝不覆盖已有 SKU）。 */
export function groupBackfill(
  epcs: readonly string[],
  known: ReadonlyMap<string, string | null>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const epc of epcs) {
    const sku = known.get(epc);
    if (!sku) continue;
    out.set(sku, [...(out.get(sku) ?? []), epc]);
  }
  return out;
}
