export const CATEGORY_GROUP_SYNC_CONFIRM = "SYNC_ERP_CATEGORIES_TO_YOUZAN_GROUPS";
export const CATEGORY_GROUP_SYNC_HOST = "erp.boomeroff.com";

export type ErpCategoryRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  kind: string | null;
};

export type PublicCategory = ErpCategoryRow & { depth: number };

export type HqProductSeed = {
  category_code: string;
  stored_item_id: number;
  name: string;
  item_codes: string[];
  barcodes: string[];
};

export type YouzanBaseItem = {
  item_id: number;
  channel_item_id: number | null;
  kdt_id: number | null;
  root_kdt_id: number | null;
  title: string;
  item_code: string;
  item_barcode: string;
};

type CategoryGroupSyncRequest = {
  dry_run?: unknown;
  confirm?: unknown;
  channels?: unknown;
  category_codes?: unknown;
  max_items?: unknown;
};

function safePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)),
  );
}

export function selectPublicCategoryTree(
  rows: ErpCategoryRow[],
  requestedRootCodes: string[] = [],
): PublicCategory[] {
  const candidates = rows.filter(
    (row) =>
      row.is_active &&
      row.kind === "category" &&
      Number.isFinite(row.sort_order) &&
      row.sort_order < 9_000,
  );
  const byParent = new Map<string | null, ErpCategoryRow[]>();
  for (const row of candidates) {
    const siblings = byParent.get(row.parent_id) ?? [];
    siblings.push(row);
    byParent.set(row.parent_id, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh-CN"));
  }

  const requested = new Set(requestedRootCodes);
  const roots = (byParent.get(null) ?? []).filter(
    (root) => requested.size === 0 || requested.has(root.code),
  );
  const selected: PublicCategory[] = [];
  const walk = (category: ErpCategoryRow, depth: number) => {
    selected.push({ ...category, depth });
    for (const child of byParent.get(category.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return selected.sort(
    (a, b) => a.depth - b.depth || a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh-CN"),
  );
}

export function buildGroupSearchParams(kdtId: number, channel: 0 | 1, pageNo: number) {
  return {
    request: { kdt_id: kdtId, channel, page_no: pageNo },
  };
}

export function buildGroupChildrenParams(
  kdtId: number,
  channel: 0 | 1,
  groupId: number,
  pageNo: number,
) {
  return {
    request: { kdt_id: kdtId, channel, group_id: groupId, page_no: pageNo },
  };
}

export function buildGroupCreateParams(args: {
  kdtId: number;
  channel: 0 | 1;
  title: string;
  parentGroupId?: number | null;
}) {
  const request: Record<string, unknown> = {
    kdt_id: args.kdtId,
    channel: args.channel,
    title: args.title,
    parent_group_id: args.parentGroupId ?? 0,
  };
  return { request };
}

export function buildGroupRelationQueryParams(
  kdtId: number,
  channel: 0 | 1,
  itemId: number,
) {
  return {
    request: {
      kdt_id: kdtId,
      channel,
      item_id: itemId,
    },
  };
}

export function buildGroupRelationUpdateParams(args: {
  kdtId: number;
  channel: 0 | 1;
  itemIds: number[];
  groupIds: number[];
}) {
  return {
    kdt_id: String(args.kdtId),
    channel: args.channel,
    item_ids: JSON.stringify(args.itemIds.slice(0, 10)),
    group_ids: JSON.stringify(args.groupIds.slice(0, 10)),
    operate_type: 3,
  };
}

export function buildHqItemSearchParams(args: {
  kdtId: number;
  channel: 0 | 1;
  itemCode?: string;
  title?: string;
}) {
  return {
    kdt_id: args.kdtId,
    channel: args.channel,
    is_displays: [0, 1],
    page_no: 1,
    page_size: 50,
    ...(args.itemCode ? { item_codes: [args.itemCode] } : {}),
    ...(args.title ? { title: args.title } : {}),
  };
}

export function selectUniqueHqItem(
  rows: YouzanBaseItem[],
  seed: HqProductSeed,
): YouzanBaseItem | null {
  const allowedCodes = new Set(seed.item_codes.map((value) => value.trim()).filter(Boolean));
  const exactCode = rows.filter((row) => allowedCodes.has(row.item_code));
  const candidates = exactCode.length > 0
    ? exactCode
    : rows.filter((row) => row.title.trim() === seed.name.trim());
  const uniqueByItemId = new Map(
    candidates.filter((row) => row.item_id > 0).map((row) => [row.item_id, row]),
  );
  if (uniqueByItemId.size === 0) return null;
  if (uniqueByItemId.size > 1) {
    throw new Error(
      `有赞总部商品匹配不唯一：${seed.category_code}/${seed.name} -> ${Array.from(uniqueByItemId.keys()).join(",")}`,
    );
  }
  return Array.from(uniqueByItemId.values())[0];
}

export function buildProductGroupAssignments(args: {
  categories: PublicCategory[];
  productLinks: Array<{ category_code: string | null; item_id: number | string | null }>;
  groupIdsByCategoryCode: Map<string, number>;
}) {
  const allowedCodes = new Set(args.categories.map((category) => category.code));
  const itemIdsByCode = new Map<string, Set<number>>();
  for (const link of args.productLinks) {
    const code = String(link.category_code ?? "").trim();
    const itemId = safePositiveInteger(link.item_id);
    if (!allowedCodes.has(code) || !itemId) continue;
    const itemIds = itemIdsByCode.get(code) ?? new Set<number>();
    itemIds.add(itemId);
    itemIdsByCode.set(code, itemIds);
  }
  return args.categories.flatMap((category) => {
    const groupId = args.groupIdsByCategoryCode.get(category.code);
    const itemIds = Array.from(itemIdsByCode.get(category.code) ?? []).sort((a, b) => a - b);
    return groupId && itemIds.length > 0
      ? [{ categoryCode: category.code, groupId, itemIds }]
      : [];
  });
}

export function selectProductLinksForCategories<
  T extends { category_code: string; item_id: number },
>(args: {
  categories: PublicCategory[];
  productLinks: T[];
  maxItems: number;
}) {
  const allowedCodes = new Set(args.categories.map((category) => category.code));
  return args.productLinks
    .filter((link) => allowedCodes.has(link.category_code))
    .slice(0, args.maxItems);
}

export function parseCategoryGroupSyncRequest(body: CategoryGroupSyncRequest) {
  const dryRun = body.dry_run !== false;
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  if (!dryRun && confirm !== CATEGORY_GROUP_SYNC_CONFIRM) {
    throw new Error(`正式同步必须传 confirm=${CATEGORY_GROUP_SYNC_CONFIRM}`);
  }
  const requestedChannels = Array.isArray(body.channels)
    ? body.channels.map(Number).filter((channel): channel is 0 | 1 => channel === 0 || channel === 1)
    : [0, 1];
  const channels = Array.from(new Set(requestedChannels)).sort() as Array<0 | 1>;
  if (channels.length === 0) throw new Error("channels 只能包含 0 或 1");
  const maxItems = Math.min(10_000, Math.max(1, Number(body.max_items) || 10_000));
  return {
    dryRun,
    confirm,
    channels,
    categoryCodes: uniqueStrings(body.category_codes),
    maxItems: Math.floor(maxItems),
  };
}

export function assertCategoryGroupSyncHost(hostname: string, dryRun: boolean): void {
  if (!dryRun && hostname !== CATEGORY_GROUP_SYNC_HOST) {
    throw new Error(`正式同步只能从腾讯固定出口 ${CATEGORY_GROUP_SYNC_HOST} 执行`);
  }
}

export function chunkYouzanItemIds(itemIds: number[], size = 10): number[][] {
  const chunks: number[][] = [];
  for (let index = 0; index < itemIds.length; index += size) {
    chunks.push(itemIds.slice(index, index + size));
  }
  return chunks;
}
