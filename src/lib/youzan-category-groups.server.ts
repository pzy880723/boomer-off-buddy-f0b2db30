import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import {
  buildGroupChildrenParams,
  buildGroupCreateParams,
  buildGroupRelationQueryParams,
  buildGroupRelationUpdateParams,
  buildGroupSearchParams,
  buildHqItemSearchParams,
  buildProductGroupAssignments,
  chunkYouzanItemIds,
  selectPublicCategoryTree,
  selectUniqueHqItem,
  type ErpCategoryRow,
  type HqProductSeed,
  type YouzanBaseItem,
} from "./youzan-category-groups";
import { callYouzanApiVerbose, ensureAccessToken, getHqShop } from "./youzan.functions";

type RemoteGroup = {
  id: number;
  title: string;
  parentId: number | null;
};

type ProductLink = {
  category_code: string;
  item_id: number;
  stored_item_id: number;
  channel_item_id: number | null;
  title: string;
  item_code: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = String(record[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function collectRemoteGroups(payload: unknown, forcedParentId: number | null): RemoteGroup[] {
  const groups = new Map<number, RemoteGroup>();
  const visited = new Set<unknown>();
  const walk = (value: unknown, depth = 0) => {
    if (!value || depth > 7 || visited.has(value)) return;
    if (typeof value === "object") visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const id = positiveInteger(record.group_id ?? record.groupId ?? record.id ?? record.tag_id);
    const title = firstString(record, ["title", "name", "group_name", "groupName", "tag_name"]);
    if (id && title) {
      groups.set(id, {
        id,
        title,
        parentId:
          positiveInteger(record.parent_group_id ?? record.parentGroupId ?? record.parent_id) ??
          forcedParentId,
      });
    }
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(payload);
  return Array.from(groups.values());
}

function extractCreatedGroupId(payload: unknown): number | null {
  const record = asRecord(payload);
  const direct = record
    ? positiveInteger(record.group_id ?? record.groupId ?? record.id ?? record.tag_id)
    : null;
  if (direct) return direct;
  const groups = collectRemoteGroups(payload, null);
  return groups[0]?.id ?? null;
}

function collectRelationGroupIds(payload: unknown): number[] {
  const ids = new Set<number>();
  const visited = new Set<unknown>();
  const walk = (value: unknown, key = "", depth = 0) => {
    if (!value || depth > 8 || visited.has(value)) return;
    if (typeof value === "object") visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, key, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) {
      if (/group.*id|tag.*id/i.test(key)) {
        const id = positiveInteger(value);
        if (id) ids.add(id);
      }
      return;
    }
    for (const [childKey, child] of Object.entries(record)) {
      if (/group.*id|tag.*id/i.test(childKey)) {
        if (Array.isArray(child)) {
          for (const item of child) {
            const id = positiveInteger(item);
            if (id) ids.add(id);
          }
        } else {
          const id = positiveInteger(child);
          if (id) ids.add(id);
        }
      }
      walk(child, childKey, depth + 1);
    }
  };
  walk(payload);
  return Array.from(ids).sort((a, b) => a - b);
}

function collectBaseSearchItems(payload: unknown): YouzanBaseItem[] {
  const items = new Map<number, YouzanBaseItem>();
  const visited = new Set<unknown>();
  const walk = (value: unknown, depth = 0) => {
    if (!value || depth > 7 || visited.has(value)) return;
    if (typeof value === "object") visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const itemId = positiveInteger(record.item_id ?? record.itemId);
    const title = firstString(record, ["title", "name"]);
    if (itemId && title) {
      items.set(itemId, {
        item_id: itemId,
        channel_item_id: positiveInteger(record.channel_item_id ?? record.channelItemId),
        kdt_id: positiveInteger(record.kdt_id ?? record.kdtId),
        root_kdt_id: positiveInteger(record.root_kdt_id ?? record.rootKdtId),
        title,
        item_code: firstString(record, ["item_code", "itemCode", "outer_id", "outerId"]),
        item_barcode: firstString(record, ["item_barcode", "itemBarcode"]),
      });
    }
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(payload);
  return Array.from(items.values());
}

async function listRemoteGroups(args: {
  accessToken: string;
  kdtId: number;
  channel: 0 | 1;
}) {
  const roots: RemoteGroup[] = [];
  for (let pageNo = 1; pageNo <= 250; pageNo += 1) {
    const response = await callYouzanApiVerbose({
      accessToken: args.accessToken,
      method: "youzan.item.group.search",
      version: "1.0.0",
      params: buildGroupSearchParams(args.kdtId, args.channel, pageNo),
      timeoutMs: 20_000,
    });
    const page = collectRemoteGroups(response.payload, null).filter((group) => group.parentId == null);
    roots.push(...page);
    if (page.length < 20) break;
  }

  const children: RemoteGroup[] = [];
  for (const root of roots) {
    for (let pageNo = 1; pageNo <= 250; pageNo += 1) {
      const response = await callYouzanApiVerbose({
        accessToken: args.accessToken,
        method: "youzan.item.group.children.get",
        version: "1.0.0",
        params: buildGroupChildrenParams(args.kdtId, args.channel, root.id, pageNo),
        timeoutMs: 20_000,
      });
      const page = collectRemoteGroups(response.payload, root.id).filter(
        (group) => group.id !== root.id,
      );
      children.push(...page);
      if (page.length < 20) break;
    }
  }
  return Array.from(new Map([...roots, ...children].map((group) => [group.id, group])).values());
}

function findMatchingRemoteGroup(
  remoteGroups: RemoteGroup[],
  title: string,
  parentId: number | null,
) {
  return remoteGroups.find(
    (group) => group.title === title && (group.parentId ?? null) === (parentId ?? null),
  );
}

async function loadSourceData(hqShopId: string, requestedRootCodes: string[]) {
  const [{ data: categoryRows, error: categoryError }, { data: skuRows, error: skuError }] =
    await Promise.all([
      supabase
        .from("inv_categories")
        .select("id, code, name, parent_id, sort_order, is_active, kind")
        .order("sort_order", { ascending: true }),
      supabase.from("inv_skus").select("id, category, name, sku_code, barcode"),
    ]);
  if (categoryError) throw new Error(categoryError.message);
  if (skuError) throw new Error(skuError.message);

  const categories = selectPublicCategoryTree(
    (categoryRows ?? []) as ErpCategoryRow[],
    requestedRootCodes,
  );
  const skuIds = (skuRows ?? []).map((sku) => sku.id);
  const links: Array<{ sku_id: string; yz_item_id: number | null }> = [];
  for (let offset = 0; offset < skuIds.length; offset += 500) {
    const { data, error } = await supabase
      .from("sku_youzan_links")
      .select("sku_id, yz_item_id")
      .eq("shop_id", hqShopId)
      .eq("role", "hq_spu")
      .eq("status", "linked")
      .in("sku_id", skuIds.slice(offset, offset + 500));
    if (error) throw new Error(error.message);
    links.push(...((data ?? []) as Array<{ sku_id: string; yz_item_id: number | null }>));
  }
  const skuById = new Map((skuRows ?? []).map((sku) => [sku.id, sku]));
  const seedsByStoredItemId = new Map<number, HqProductSeed>();
  for (const link of links) {
    const storedItemId = positiveInteger(link.yz_item_id);
    const sku = skuById.get(link.sku_id);
    const categoryCode = String(sku?.category ?? "").trim();
    if (!storedItemId || !sku || !categoryCode) continue;
    const existing = seedsByStoredItemId.get(storedItemId);
    if (existing && existing.category_code !== categoryCode) {
      throw new Error(`同一个有赞总部商品 ${storedItemId} 被绑定到多个 ERP 分类`);
    }
    const seed = existing ?? {
      category_code: categoryCode,
      stored_item_id: storedItemId,
      name: String(sku.name ?? "").trim(),
      item_codes: [],
      barcodes: [],
    };
    const itemCode = String(sku.sku_code ?? "").trim();
    const barcode = String(sku.barcode ?? "").trim();
    if (itemCode && !seed.item_codes.includes(itemCode)) seed.item_codes.push(itemCode);
    if (barcode && !seed.barcodes.includes(barcode)) seed.barcodes.push(barcode);
    seedsByStoredItemId.set(storedItemId, seed);
  }
  const allowedCodes = new Set(categories.map((category) => category.code));
  const productSeeds = Array.from(seedsByStoredItemId.values()).filter((seed) =>
    allowedCodes.has(seed.category_code),
  );
  return { categories, productSeeds };
}

async function resolveHqProductLinks(args: {
  accessToken: string;
  hqKdtId: number;
  channel: 0 | 1;
  seeds: HqProductSeed[];
}) {
  const links: ProductLink[] = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const seed of args.seeds) {
    let matched: YouzanBaseItem | null = null;
    for (const itemCode of seed.item_codes.slice(0, 3)) {
      const response = await callYouzanApiVerbose({
        accessToken: args.accessToken,
        method: "youzan.item.base.search",
        version: "1.0.0",
        params: buildHqItemSearchParams({
          kdtId: args.hqKdtId,
          channel: args.channel,
          itemCode,
        }),
        timeoutMs: 20_000,
      });
      const rows = collectBaseSearchItems(response.payload).filter(
        (row) => !row.root_kdt_id || row.root_kdt_id === args.hqKdtId,
      );
      matched = selectUniqueHqItem(rows, seed);
      if (matched) break;
    }
    if (!matched) {
      const response = await callYouzanApiVerbose({
        accessToken: args.accessToken,
        method: "youzan.item.base.search",
        version: "1.0.0",
        params: buildHqItemSearchParams({
          kdtId: args.hqKdtId,
          channel: args.channel,
          title: seed.name,
        }),
        timeoutMs: 20_000,
      });
      const rows = collectBaseSearchItems(response.payload).filter(
        (row) => !row.root_kdt_id || row.root_kdt_id === args.hqKdtId,
      );
      matched = selectUniqueHqItem(rows, seed);
    }
    if (!matched) {
      if (args.channel === 1) {
        skipped.push({
          category_code: seed.category_code,
          stored_item_id: seed.stored_item_id,
          title: seed.name,
          reason: "not_published_to_store_channel",
        });
        continue;
      }
      throw new Error(
        `有赞总部未找到 ERP 商品：channel=${args.channel} ${seed.category_code}/${seed.name}`,
      );
    }
    links.push({
      category_code: seed.category_code,
      item_id: matched.item_id,
      stored_item_id: seed.stored_item_id,
      channel_item_id: matched.channel_item_id,
      title: matched.title,
      item_code: matched.item_code,
    });
  }
  return { links, skipped };
}

async function createAuditRun(input: Record<string, unknown>) {
  const { data, error } = await (supabase as any)
    .from("youzan_category_group_sync_runs")
    .insert(input)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return String(data.id);
}

async function updateAuditRun(id: string, values: Record<string, unknown>) {
  const { error } = await (supabase as any)
    .from("youzan_category_group_sync_runs")
    .update(values)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function syncErpCategoriesToYouzanGroups(args: {
  dryRun: boolean;
  channels: Array<0 | 1>;
  categoryCodes: string[];
  maxItems: number;
}) {
  const hq = await getHqShop();
  const accessToken = await ensureAccessToken(hq);
  const source = await loadSourceData(hq.id, args.categoryCodes);
  const selectedProductSeeds = source.productSeeds.slice(0, args.maxItems);
  const runId = await createAuditRun({
    status: "running",
    dry_run: args.dryRun,
    hq_shop_id: hq.id,
    hq_kdt_id: hq.kdt_id,
    channels: args.channels,
    category_codes: args.categoryCodes,
    source_snapshot: {
      categories: source.categories,
      product_seeds: selectedProductSeeds,
    },
  });

  const channelResults: Array<Record<string, unknown>> = [];
  try {
    for (const channel of args.channels) {
      const productResolution = await resolveHqProductLinks({
        accessToken,
        hqKdtId: Number(hq.kdt_id),
        channel,
        seeds: selectedProductSeeds,
      });
      const productLinks = productResolution.links;
      const relationSnapshots: Array<Record<string, unknown>> = [];
      for (const link of productLinks) {
        const response = await callYouzanApiVerbose({
          accessToken,
          method: "youzan.item.itemgroup.get",
          version: "1.0.0",
          params: buildGroupRelationQueryParams(Number(hq.kdt_id), channel, link.item_id),
          timeoutMs: 20_000,
        });
        relationSnapshots.push({
          category_code: link.category_code,
          item_id: link.item_id,
          previous_group_ids: collectRelationGroupIds(response.payload),
        });
      }

      const remoteGroups = await listRemoteGroups({
        accessToken,
        kdtId: Number(hq.kdt_id),
        channel,
      });
      const groupIdsByCategoryCode = new Map<string, number>();
      const creates: Array<Record<string, unknown>> = [];
      const resolvedGroups: Array<Record<string, unknown>> = [];
      for (const category of source.categories) {
        const parentGroupId = category.parent_id
          ? groupIdsByCategoryCode.get(
              source.categories.find((candidate) => candidate.id === category.parent_id)?.code ?? "",
            ) ?? null
          : null;
        let remote = findMatchingRemoteGroup(remoteGroups, category.name, parentGroupId);
        let created = false;
        if (!remote && !args.dryRun) {
          const response = await callYouzanApiVerbose({
            accessToken,
            method: "youzan.item.group.create",
            version: "1.0.0",
            params: buildGroupCreateParams({
              kdtId: Number(hq.kdt_id),
              channel,
              title: category.name,
              parentGroupId,
            }),
            timeoutMs: 20_000,
          });
          const groupId = extractCreatedGroupId(response.payload);
          if (!groupId) throw new Error(`有赞创建分组 ${category.name} 成功但未返回 group_id`);
          remote = { id: groupId, title: category.name, parentId: parentGroupId };
          remoteGroups.push(remote);
          created = true;
        }
        if (!remote) {
          creates.push({
            category_code: category.code,
            title: category.name,
            parent_category_id: category.parent_id,
          });
          continue;
        }
        groupIdsByCategoryCode.set(category.code, remote.id);
        resolvedGroups.push({
          category_id: category.id,
          category_code: category.code,
          title: category.name,
          group_id: remote.id,
          parent_group_id: parentGroupId,
          created,
        });
        if (!args.dryRun) {
          const { error } = await (supabase as any).from("youzan_category_group_links").upsert(
            {
              category_id: category.id,
              hq_shop_id: hq.id,
              channel,
              youzan_group_id: remote.id,
              parent_youzan_group_id: parentGroupId,
              group_name: category.name,
              status: "active",
              synced_at: new Date().toISOString(),
              last_error: null,
            },
            { onConflict: "category_id,hq_shop_id,channel" },
          );
          if (error) throw new Error(error.message);
        }
      }

      const assignments = buildProductGroupAssignments({
        categories: source.categories,
        productLinks,
        groupIdsByCategoryCode,
      });
      const updates: Array<Record<string, unknown>> = [];
      for (const assignment of assignments) {
        for (const itemIds of chunkYouzanItemIds(assignment.itemIds)) {
          if (args.dryRun) {
            updates.push({
              category_code: assignment.categoryCode,
              item_ids: itemIds,
              group_ids: [assignment.groupId],
              operate_type: 3,
              applied: false,
            });
            continue;
          }
          await callYouzanApiVerbose({
            accessToken,
            method: "youzan.item.itemgroup.update",
            version: "1.0.0",
            params: buildGroupRelationUpdateParams({
              kdtId: Number(hq.kdt_id),
              channel,
              itemIds,
              groupIds: [assignment.groupId],
            }),
            timeoutMs: 20_000,
          });
          const verifiedGroupsByItem: Record<string, number[]> = {};
          for (const itemId of itemIds) {
            const after = await callYouzanApiVerbose({
              accessToken,
              method: "youzan.item.itemgroup.get",
              version: "1.0.0",
              params: buildGroupRelationQueryParams(Number(hq.kdt_id), channel, itemId),
              timeoutMs: 20_000,
            });
            const verifiedGroupIds = collectRelationGroupIds(after.payload);
            if (!verifiedGroupIds.includes(assignment.groupId)) {
              throw new Error(
                `分组覆盖后校验失败：${assignment.categoryCode} item=${itemId} group=${assignment.groupId}`,
              );
            }
            verifiedGroupsByItem[String(itemId)] = verifiedGroupIds;
          }
          updates.push({
            category_code: assignment.categoryCode,
            item_ids: itemIds,
            group_ids: [assignment.groupId],
            operate_type: 3,
            applied: true,
            verified_groups_by_item: verifiedGroupsByItem,
          });
        }
      }
      channelResults.push({
        channel,
        resolved_products: productLinks,
        skipped_products: productResolution.skipped,
        remote_groups_before: remoteGroups,
        planned_creates: creates,
        resolved_groups: resolvedGroups,
        relation_snapshots: relationSnapshots,
        updates,
      });
    }

    const result = {
      run_id: runId,
      dry_run: args.dryRun,
      hq: { id: hq.id, kdt_id: Number(hq.kdt_id), shop_name: hq.shop_name },
      category_count: source.categories.length,
      product_count: selectedProductSeeds.length,
      channels: channelResults,
      safeguards: {
        excludes_workflow_categories: true,
        overwrites_group_relation_only: true,
        preserves_retail_category_id: true,
        deletes_remote_groups: false,
      },
    };
    await updateAuditRun(runId, {
      status: "completed",
      result,
      completed_at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    await updateAuditRun(runId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      result: { channels: channelResults },
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}

export const categoryGroupServerInternals = {
  collectRemoteGroups,
  collectRelationGroupIds,
};
