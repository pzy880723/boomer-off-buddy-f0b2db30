// 渠道同步 worker 的纯安全判定：调用方鉴权、清零/下架前置校验、售出闭环判定。
export const ZEROING_ACTIONS = new Set(["set_stock_zero", "delist"]);

/** 只接受服务角色 Bearer；公开 apikey / 空值一律拒绝。等长比较避免时序泄露。 */
export function isServiceBearer(header: string | null, serviceKey: string): boolean {
  if (!serviceKey || !header || !header.startsWith("Bearer ")) return false;
  const got = header.slice(7);
  if (got.length !== serviceKey.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ serviceKey.charCodeAt(i);
  return diff === 0;
}

export type ZeroingTask = { sku_id: string; shop_id: string | null; channel_listing_id: string | null; action: string; inventory_version: number };
export type ZeroingFacts = {
  /** null = 读取失败或不存在 */
  sku: { inventory_version: number; sales_state: string | null; is_display: boolean | null } | null;
  /** 任务门店库位的真实 inv_stocks 数量；null = 读取失败/门店无库位 */
  stockQty: number | null;
  listing: { sku_id: string; shop_id: string | null } | null;
};
export type ZeroingVerdict = { verdict: "proceed" | "supersede" | "block"; reason: string };

export function evaluateZeroingTask(task: ZeroingTask, f: ZeroingFacts): ZeroingVerdict {
  if (!f.sku) return { verdict: "block", reason: "sku 读取失败" };
  if (!Number.isSafeInteger(Number(f.sku.inventory_version)) || !Number.isSafeInteger(Number(task.inventory_version)) ||
      typeof f.sku.is_display !== "boolean") return { verdict: "block", reason: "sku 版本或展示状态不完整" };
  if (f.stockQty === null || !Number.isFinite(f.stockQty)) return { verdict: "block", reason: "门店库存读取失败或门店无库位" };
  if (!task.channel_listing_id || !f.listing) return { verdict: "block", reason: "listing 读取失败" };
  if (f.listing.sku_id !== task.sku_id || !task.shop_id || f.listing.shop_id !== task.shop_id) {
    return { verdict: "block", reason: "listing 归属与任务不一致" };
  }
  if (Number(f.sku.inventory_version) > Number(task.inventory_version)) {
    return { verdict: "supersede", reason: `sku inventory_version=${f.sku.inventory_version} > task ${task.inventory_version}` };
  }
  if (f.stockQty > 0) return { verdict: "supersede", reason: `门店实库存 ${f.stockQty} > 0` };
  if (f.sku.is_display === true) return { verdict: "supersede", reason: "商品仍在展示" };
  if (!["sold_syncing", "sold"].includes(String(f.sku.sales_state))) {
    return { verdict: "supersede", reason: `sales_state=${f.sku.sales_state} 非售出` };
  }
  return { verdict: "proceed", reason: "ok" };
}

/** 售出闭环：清零与下架均有成功，且无未完成或 dead_letter 的同类任务。 */
export function canMarkSold(tasks: Array<{ action: string; status: string }>): boolean {
  const z = tasks.filter((t) => ZEROING_ACTIONS.has(t.action));
  if (z.some((t) => ["pending", "running", "retry_wait", "dead_letter"].includes(t.status))) return false;
  return ["set_stock_zero", "delist"].every((a) => z.some((t) => t.action === a && t.status === "succeeded"));
}
