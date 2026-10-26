/**
 * 自动铺货目标解析（纯函数，无任何 IO）。
 *
 * 防复发约束（2026-10-26 美罗城事故）：
 * - 标准品（single + 非自定义价 + unlimited）保持全店共享，不受本模块约束。
 * - 自定义/孤品只允许铺到「明确指定的 default_shop_ids」或「有正库存的库位所属分店」。
 * - 两者都为空时必须跳过，绝不允许兜底成「全部启用分店」——否则新增门店会被
 *   自动铺入历史他店商品。
 */

export type AutoDistributeSku = {
  id: string;
  kind: string | null;
  is_custom_price: boolean | null;
  inventory_policy: string | null;
};

export type AutoDistributePlan = {
  /** 标准品：走全店共享同步，不进 customTargets */
  standardIds: Set<string>;
  /** 自定义品：sku id → 明确的目标分店 id 列表（已去重） */
  customTargets: Map<string, string[]>;
  /** 自定义品但无任何明确目标：跳过，不写有赞 */
  skippedCustomIds: string[];
};

export function isStandardSharedSku(sku: AutoDistributeSku): boolean {
  return (
    sku.kind === "single" &&
    sku.is_custom_price === false &&
    sku.inventory_policy === "unlimited"
  );
}

export function planAutoDistributeTargets(args: {
  skus: AutoDistributeSku[];
  defaultShopIds: readonly string[];
  /** sku id → 有正库存的库位所属分店 id 列表（调用方已过滤为启用分店） */
  stockShopIdsBySku: ReadonlyMap<string, readonly string[]>;
}): AutoDistributePlan {
  const standardIds = new Set<string>();
  const customTargets = new Map<string, string[]>();
  const skippedCustomIds: string[] = [];
  const explicitTargets = Array.from(new Set(args.defaultShopIds));

  for (const sku of args.skus) {
    const id = String(sku.id);
    if (isStandardSharedSku(sku)) {
      standardIds.add(id);
      continue;
    }
    const targets =
      explicitTargets.length > 0
        ? explicitTargets
        : Array.from(new Set(args.stockShopIdsBySku.get(id) ?? []));
    if (targets.length === 0) {
      skippedCustomIds.push(id);
      continue;
    }
    customTargets.set(id, targets);
  }
  return { standardIds, customTargets, skippedCustomIds };
}
