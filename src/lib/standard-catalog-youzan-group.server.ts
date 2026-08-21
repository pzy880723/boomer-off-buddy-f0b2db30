import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import {
  buildStandardChannelPublishParams,
  buildHqSpuLookupParams,
  buildStandardGroupSpuCreateParams,
  groupStandardCatalogSkus,
  isRecoverableStandardChannelPublishError,
  selectExactStandardBranchGroup,
  selectValidYouzanRetailCategory,
  type StandardCatalogGroup,
  type StandardCatalogSku,
  type StandardCatalogTargetShop,
} from "./standard-catalog-youzan-sync";
import {
  buildOfflineChannelListingRow,
  buildOfflineStockQueueRow,
  resolveOfflineReleaseSourceImages,
} from "./youzan-offline-products.server";
import { getPublicOrigin } from "./sku-media";
import {
  ensureAccessToken,
  getHqShop,
  callYouzanApiVerbose,
} from "./youzan.functions";
import {
  runStockSyncWorkerForSkus,
  uploadImageToYouzanMaterial,
} from "./youzan-sync.functions";

type SourceStandardSku = StandardCatalogSku & {
  image_url: string | null;
  image_paths: unknown[] | null;
  sku_scope: string | null;
};

type HqGroup = {
  spuId: number;
  spuCode: string;
  skus: Array<{ skuId: number; skuCode: string; skuNo: string }>;
};

type BranchGroup = {
  itemId: number;
  skus: Array<{ skuId: number; skuNo: string | null }>;
};

function collectSpuRows(payload: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const visited = new Set<unknown>();
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          rows.push(item as Record<string, unknown>);
        }
      }
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of ["spus", "spu_list", "spuList", "items", "list", "records"]) {
      walk(object[key], depth + 1);
    }
    for (const key of ["data", "response", "result"]) walk(object[key], depth + 1);
  };
  walk(payload);
  return rows;
}

function normalizeHqGroup(row: Record<string, unknown>): HqGroup | null {
  const spuId = Number(row.spu_id ?? row.spuId ?? row.item_id ?? row.itemId ?? row.id ?? 0);
  const spuCode = String(
    row.spu_code ?? row.spuCode ?? row.outer_id ?? row.outerId ?? "",
  ).trim();
  if (!spuId || !spuCode) return null;
  const rawSkus = Array.isArray(row.skus ?? row.sku_list ?? row.skuList)
    ? ((row.skus ?? row.sku_list ?? row.skuList) as Array<Record<string, unknown>>)
    : [];
  return {
    spuId,
    spuCode,
    skus: rawSkus.flatMap((sku) => {
      const skuId = Number(sku.sku_id ?? sku.skuId ?? sku.id ?? 0);
      if (!skuId) return [];
      return [{
        skuId,
        skuCode: String(
          sku.sku_code ?? sku.skuCode ?? sku.outer_sku_id ?? sku.outerSkuId ?? "",
        ).trim(),
        skuNo: String(sku.sku_no ?? sku.skuNo ?? "").trim(),
      }];
    }),
  };
}

function pickCreatedId(payload: unknown): number {
  const visited = new Set<unknown>();
  const walk = (value: unknown, depth = 0): number => {
    if (!value || typeof value !== "object" || depth > 5 || visited.has(value)) return 0;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) {
        const id = walk(child, depth + 1);
        if (id) return id;
      }
      return 0;
    }
    const object = value as Record<string, unknown>;
    for (const key of ["spu_id", "spuId", "item_id", "itemId", "id"]) {
      const id = Number(object[key] ?? 0);
      if (id > 0) return id;
    }
    for (const child of Object.values(object)) {
      const id = walk(child, depth + 1);
      if (id) return id;
    }
    return 0;
  };
  return walk(payload);
}

function collectRetailCategories(payload: unknown) {
  const categories: Array<{ id: number; name: string }> = [];
  const seen = new Set<number>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const row = value as Record<string, unknown>;
    const id = Number(row.category_id ?? 0);
    const name = String(row.name ?? row.category_name ?? "").trim();
    if (id > 0 && name && !seen.has(id)) {
      seen.add(id);
      categories.push({ id, name });
    }
    Object.values(row).forEach(walk);
  };
  walk(payload);
  return categories;
}

async function resolveLiveRetailCategory(accessToken: string) {
  const result = await callYouzanApiVerbose({
    accessToken,
    method: "youzan.retail.open.category.query",
    version: "3.0.0",
    params: {},
    timeoutMs: 20_000,
  });
  const categories = collectRetailCategories(result.payload);
  const { data: setting, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "youzan_hq_default_category_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const value = (setting as { value?: unknown } | null)?.value;
  const storedId = Number(
    typeof value === "object" && value ? (value as { id?: unknown }).id : value,
  );
  const category = selectValidYouzanRetailCategory(categories, storedId);
  if (!category) throw new Error("有赞没有返回可用的零售商品类目");
  if (category.id !== storedId) {
    const { error: saveError } = await supabase.from("app_settings").upsert({
      key: "youzan_hq_default_category_id",
      value: { id: category.id, name: category.name, source: "retail.open.category.query" },
      updated_at: new Date().toISOString(),
    } as never);
    if (saveError) throw new Error(saveError.message);
  }
  return category;
}

async function loadStandardGroupContainingSku(skuId: string) {
  const { data: seed, error: seedError } = await supabase
    .from("inv_skus")
    .select("id,sku_code,barcode,name,category,price_tier,image_url,image_paths,sku_scope")
    .eq("id", skuId)
    .eq("kind", "single")
    .eq("is_custom_price", false)
    .eq("inventory_policy", "unlimited")
    .eq("is_display", true)
    .maybeSingle();
  if (seedError) throw new Error(seedError.message);
  if (!seed) throw new Error("找不到可同步的标准商品 SKU");

  let query = supabase
    .from("inv_skus")
    .select("id,sku_code,barcode,name,category,price_tier,image_url,image_paths,sku_scope")
    .eq("kind", "single")
    .eq("is_custom_price", false)
    .eq("inventory_policy", "unlimited")
    .eq("is_display", true);
  query = seed.sku_code
    ? query.eq("sku_code", seed.sku_code)
    : query.eq("category", seed.category).eq("name", seed.name);
  const { data, error } = await query.order("price_tier", { ascending: true });
  if (error) throw new Error(error.message);
  const sourceRows = (data ?? []) as SourceStandardSku[];
  const group = groupStandardCatalogSkus(sourceRows)[0];
  if (!group) throw new Error("标准商品价格档为空");
  return { group, sourceRows };
}

async function findHqGroup(accessToken: string, code: string): Promise<HqGroup | null> {
  for (const params of buildHqSpuLookupParams(code)) {
    try {
      const result = await callYouzanApiVerbose({
        accessToken,
        method: "youzan.retail.open.spu.query",
        version: "3.0.0",
        params,
        timeoutMs: 20_000,
      });
      const matched = collectSpuRows(result.payload)
        .map(normalizeHqGroup)
        .find((row) => row?.spuCode === code);
      if (matched) return matched;
    } catch {
      // Different Youzan tenants accept different optional query filters.
    }
  }
  return null;
}

function mapHqSkuIds(group: StandardCatalogGroup, remote: HqGroup) {
  const byCode = new Map<string, number>();
  for (const sku of remote.skus) {
    if (sku.skuCode) byCode.set(sku.skuCode, sku.skuId);
    if (sku.skuNo) byCode.set(sku.skuNo, sku.skuId);
  }
  const positional = remote.skus.length === group.skus.length ? remote.skus : [];
  return group.skus.map((sku, index) => {
    const barcode = String(sku.barcode ?? "");
    const skuId = byCode.get(barcode) ?? positional[index]?.skuId ?? 0;
    if (!skuId) throw new Error(`有赞总部未返回价格档 ${sku.price_tier} 的 SKU ID`);
    return { sku, skuId };
  });
}

async function upsertHqLinks(
  group: StandardCatalogGroup,
  hqShopId: string,
  remote: HqGroup,
) {
  const mapped = mapHqSkuIds(group, remote);
  for (const { sku, skuId } of mapped) {
    const { error } = await supabase.from("sku_youzan_links").upsert({
      sku_id: sku.id,
      shop_id: hqShopId,
      yz_item_id: remote.spuId,
      yz_sku_id: skuId,
      status: "linked",
      role: "hq_spu",
      sync_stock: false,
      last_error: null,
    } as never, { onConflict: "sku_id,shop_id" });
    if (error) throw new Error(error.message);
  }
}

async function ensureGroupedHqSpu(args: {
  group: StandardCatalogGroup;
  categoryId: number;
  kdtIds: number[];
  imageUrl: string;
}) {
  const hq = await getHqShop();
  const accessToken = await ensureAccessToken(hq);
  const payload = buildStandardGroupSpuCreateParams(args);
  let remote = await findHqGroup(accessToken, args.group.code);
  let created = false;
  if (!remote) {
    const result = await callYouzanApiVerbose({
      accessToken,
      method: "youzan.retail.open.spu.create",
      version: "3.0.0",
      params: payload,
      timeoutMs: 30_000,
    });
    created = true;
    const createdId = pickCreatedId(result.payload);
    for (const waitMs of [0, 1_000, 2_000, 4_000, 8_000]) {
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      remote = await findHqGroup(accessToken, args.group.code);
      if (remote && (!createdId || remote.spuId === createdId)) break;
    }
  } else {
    const { offline_create: _offline, is_up_offline: _up, sell_channel_ids: _channels, ...fields } = payload;
    await callYouzanApiVerbose({
      accessToken,
      method: "youzan.retail.open.spu.update",
      version: "3.0.0",
      params: {
        spu_id: remote.spuId,
        ...fields,
        sell_channel_setting_request: {
          is_partial: 1,
          sell_channel_ids: args.kdtIds,
        },
      },
      timeoutMs: 30_000,
    });
    remote = await findHqGroup(accessToken, args.group.code);
  }
  if (!remote) throw new Error(`有赞总部未返回聚合商品 ${args.group.name}`);
  if (remote.skus.length !== args.group.skus.length) {
    throw new Error(
      `有赞总部商品 ${args.group.name} 规格数不一致：应有 ${args.group.skus.length}，实际 ${remote.skus.length}`,
    );
  }
  await upsertHqLinks(args.group, String(hq.id), remote);
  return { hq, accessToken, remote, created };
}

async function findBranchGroup(args: {
  accessToken: string;
  kdtId: number;
  group: StandardCatalogGroup;
}): Promise<BranchGroup | null> {
  try {
    const result = await callYouzanApiVerbose({
      accessToken: args.accessToken,
      method: "youzan.item.itemdetail.get",
      version: "1.0.0",
      params: {
        request: {
          kdt_id: args.kdtId,
          item_code: args.group.code,
          channel: 1,
        },
      },
      timeoutMs: 20_000,
    });
    const detail = result.payload && typeof result.payload === "object"
      ? result.payload as Record<string, unknown>
      : {};
    const itemId = Number(detail.channel_item_id ?? detail.item_id ?? 0);
    const rawSkus = Array.isArray(detail.skus)
      ? detail.skus as Array<Record<string, unknown>>
      : [];
    const row: BranchGroup = {
      itemId,
      skus: rawSkus.flatMap((sku) => {
        const skuId = Number(sku.channel_sku_id ?? sku.sku_id ?? 0);
        if (!skuId) return [];
        return [{
          skuId,
          skuNo: String(sku.sku_barcode ?? sku.sku_no ?? "").trim() || null,
        }];
      }),
    };
    return itemId && selectExactStandardBranchGroup([row], args.group.skus) ? row : null;
  } catch (error) {
    if (/商品不存在|not found/i.test(error instanceof Error ? error.message : String(error))) {
      return null;
    }
    throw error;
  }
}

async function resolveRootItemId(args: {
  accessToken: string;
  hqKdtId: number;
  itemCode: string;
}) {
  const result = await callYouzanApiVerbose({
    accessToken: args.accessToken,
    method: "youzan.item.base.get",
    version: "1.0.0",
    params: {
      request: {
        kdt_id: args.hqKdtId,
        item_code: args.itemCode,
        channel: 0,
      },
    },
    timeoutMs: 20_000,
  });
  const itemId = pickCreatedId(result.payload);
  if (!itemId) throw new Error(`有赞商品库未返回 ${args.itemCode} 的根商品 ID`);
  return itemId;
}

async function upsertBranchRecords(args: {
  group: StandardCatalogGroup;
  shopId: string;
  hqSpuId: number;
  itemId: number;
  remoteSkuIds: number[];
  stock: number;
}) {
  const skuIds = args.group.skus.map((sku) => sku.id);
  const { data: existingListings, error: listingReadError } = await supabase
    .from("sku_channel_listings")
    .select("id,sku_id")
    .in("sku_id", skuIds)
    .eq("channel", "youzan_branch_offline")
    .eq("shop_id", args.shopId);
  if (listingReadError) throw new Error(listingReadError.message);
  const listingIds = new Map((existingListings ?? []).map((row) => [row.sku_id, row.id]));

  for (const [index, sku] of args.group.skus.entries()) {
    const remoteSkuId = args.remoteSkuIds[index];
    if (!remoteSkuId) throw new Error(`有赞分店未返回价格档 ${sku.price_tier} 的 SKU ID`);
    const { error: linkError } = await supabase.from("sku_youzan_links").upsert({
      sku_id: sku.id,
      shop_id: args.shopId,
      yz_item_id: args.itemId,
      yz_sku_id: remoteSkuId,
      status: "linked",
      role: "branch_stock",
      sync_stock: true,
      last_error: null,
    } as never, { onConflict: "sku_id,shop_id" });
    if (linkError) throw new Error(linkError.message);

    const listing = {
      ...buildOfflineChannelListingRow({
        skuId: sku.id,
        shopId: args.shopId,
        hqSpuId: args.hqSpuId,
        itemId: args.itemId,
        skuIdRemote: remoteSkuId,
        stock: args.stock,
        recovered: false,
      }),
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const listingId = listingIds.get(sku.id);
    const listingWrite = listingId
      ? supabase.from("sku_channel_listings").update(listing as never).eq("id", listingId)
      : supabase.from("sku_channel_listings").insert(listing as never);
    const { error: listingError } = await listingWrite;
    if (listingError) throw new Error(listingError.message);

    const queueRow = buildOfflineStockQueueRow({
      skuId: sku.id,
      shopId: args.shopId,
      locationId: null,
      targetStock: args.stock,
    });
    const { data: existingQueue, error: queueReadError } = await supabase
      .from("youzan_stock_sync_queue")
      .select("id")
      .eq("sku_id", sku.id)
      .eq("shop_id", args.shopId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (queueReadError) throw new Error(queueReadError.message);
    const queueWrite = existingQueue?.id
      ? supabase.from("youzan_stock_sync_queue").update(queueRow as never).eq("id", existingQueue.id)
      : supabase.from("youzan_stock_sync_queue").insert(queueRow as never);
    const { error: queueError } = await queueWrite;
    if (queueError) throw new Error(queueError.message);
  }
}

function mapBranchSkuIds(
  group: StandardCatalogGroup,
  remoteSkus: Array<{ skuId: number; skuNo: string | null }>,
  returnedSkuIds: number[],
) {
  const byBarcode = new Map(
    remoteSkus.filter((sku) => sku.skuNo).map((sku) => [String(sku.skuNo), sku.skuId]),
  );
  const positional = remoteSkus.length === group.skus.length
    ? remoteSkus.map((sku) => sku.skuId)
    : returnedSkuIds.length === group.skus.length
      ? returnedSkuIds
      : [];
  return group.skus.map((sku, index) => {
    const remoteSkuId = byBarcode.get(String(sku.barcode ?? "")) ?? positional[index] ?? 0;
    if (!remoteSkuId) throw new Error(`有赞分店未返回价格档 ${sku.price_tier} 的 SKU ID`);
    return remoteSkuId;
  });
}

export async function syncStandardGroupContainingSkuCore(args: {
  skuId: string;
  shops: StandardCatalogTargetShop[];
  targetStock: number;
}) {
  const { group, sourceRows } = await loadStandardGroupContainingSku(args.skuId);
  const publicOrigin = getPublicOrigin();
  const imageSource = sourceRows.find((row) => row.image_url || row.image_paths?.length) ?? sourceRows[0];
  const rawImages = resolveOfflineReleaseSourceImages({
    skuScope: "standard",
    imageUrl: imageSource?.image_url,
    imagePaths: imageSource?.image_paths,
    publicOrigin,
  });
  const hq = await getHqShop();
  const accessToken = await ensureAccessToken(hq);
  const category = await resolveLiveRetailCategory(accessToken);
  const imageUrls = await Promise.all(
    rawImages.map((url) =>
      url.endsWith("/m-icon-512.png")
        ? Promise.resolve(url)
        : uploadImageToYouzanMaterial(accessToken, url, {
            shop_id: String(hq.id),
            kdt_id: Number(hq.kdt_id),
            sku_id: group.skus[0].id,
          }),
    ),
  );
  const groupedHq = await ensureGroupedHqSpu({
    group,
    categoryId: category.id,
    kdtIds: args.shops.map((shop) => Number(shop.kdt_id)),
    imageUrl: imageUrls[0] ?? `${publicOrigin}/m-icon-512.png`,
  });

  const rootItemId = await resolveRootItemId({
    accessToken: groupedHq.accessToken,
    hqKdtId: Number(groupedHq.hq.kdt_id),
    itemCode: group.code,
  });
  const existingBranches = new Map<string, BranchGroup | null>();
  for (const shop of args.shops) {
    existingBranches.set(shop.id, await findBranchGroup({
      accessToken: groupedHq.accessToken,
      kdtId: Number(shop.kdt_id),
      group,
    }));
  }
  if (Array.from(existingBranches.values()).some((remote) => !remote)) {
    try {
      await callYouzanApiVerbose({
        accessToken: groupedHq.accessToken,
        method: "youzan.item.channel.publish",
        version: "2.0.0",
        params: buildStandardChannelPublishParams(rootItemId),
        timeoutMs: 30_000,
      });
    } catch (error) {
      // Youzan may finish publishing asynchronously while returning either of these errors.
      // The branch-detail polling below is the source of truth.
      if (!isRecoverableStandardChannelPublishError(error)) throw error;
    }
  }

  const branches = [];
  for (const shop of args.shops) {
    try {
      let remote = existingBranches.get(shop.id) ?? null;
      for (const waitMs of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        remote = await findBranchGroup({
          accessToken: groupedHq.accessToken,
          kdtId: Number(shop.kdt_id),
          group,
        });
        if (remote?.skus.length === group.skus.length) break;
      }
      if (!remote || remote.skus.length !== group.skus.length) {
        throw new Error(
          `有赞分店商品 ${group.name} 规格数不一致：应有 ${group.skus.length}，实际 ${remote?.skus.length ?? 0}`,
        );
      }
      const itemId = remote.itemId;
      const remoteSkuIds = mapBranchSkuIds(group, remote.skus, []);
      await upsertBranchRecords({
        group,
        shopId: shop.id,
        hqSpuId: groupedHq.remote.spuId,
        itemId,
        remoteSkuIds,
        stock: args.targetStock,
      });

      branches.push({
        shop_id: shop.id,
        shop_name: shop.shop_name,
        ok: true,
        branch_item_id: itemId,
        sku_count: remoteSkuIds.length,
        target_stock: args.targetStock,
      });
    } catch (error) {
      branches.push({
        shop_id: shop.id,
        shop_name: shop.shop_name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (branches.some((branch) => branch.ok)) {
    const worker = await runStockSyncWorkerForSkus(group.skus.map((sku) => sku.id));
    if (worker.failed > 0) throw new Error(`有赞库存同步失败 ${worker.failed} 条`);
  }
  return {
    ok: branches.every((branch) => branch.ok),
    group: {
      key: group.key,
      code: group.code,
      name: group.name,
      sku_count: group.skus.length,
    },
    hq: {
      created: groupedHq.created,
      spu_id: groupedHq.remote.spuId,
      sku_count: groupedHq.remote.skus.length,
    },
    branches,
  };
}
