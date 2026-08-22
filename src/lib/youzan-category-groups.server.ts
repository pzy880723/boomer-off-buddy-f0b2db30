import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import {
  buildGroupChildrenParams,
  buildGroupCreateParams,
  buildGroupRelationQueryParams,
  buildGroupRelationUpdateParams,
  buildGroupSearchParams,
  buildProductGroupAssignments,
  chunkYouzanItemIds,
  selectProductLinksForCategories,
  selectPublicCategoryTree,
  type ErpCategoryRow,
  type PublicCategory,
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
  shop_id: string;
};

type TargetShop = {
  id: string;
  kdt_id: number;
  shop_name: string;
  role: "branch";
  parent_kdt_id: number | null;
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
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
  const [
    { data: categoryRows, error: categoryError },
    { data: skuRows, error: skuError },
    { data: shopRows, error: shopError },
  ] =
    await Promise.all([
      supabase
        .from("inv_categories")
        .select("id, code, name, parent_id, sort_order, is_active, kind")
        .order("sort_order", { ascending: true }),
      supabase.from("inv_skus").select("id, category"),
      supabase
        .from("youzan_shops")
        .select(
          "id, kdt_id, shop_name, role, parent_kdt_id, status, access_token, refresh_token, token_expires_at",
        )
        .eq("role", "branch")
        .eq("status", "active")
        .order("shop_name", { ascending: true }),
    ]);
  if (categoryError) throw new Error(categoryError.message);
  if (skuError) throw new Error(skuError.message);
  if (shopError) throw new Error(shopError.message);

  const categories = selectPublicCategoryTree(
    (categoryRows ?? []) as ErpCategoryRow[],
    requestedRootCodes,
  );
  const skuIds = (skuRows ?? []).map((sku) => sku.id);
  const shops = (shopRows ?? []) as TargetShop[];
  const shopIds = shops.map((shop) => shop.id);
  const links: Array<{ sku_id: string; shop_id: string; yz_item_id: number | null }> = [];
  for (let offset = 0; offset < skuIds.length; offset += 500) {
    if (shopIds.length === 0) break;
    const { data, error } = await supabase
      .from("sku_youzan_links")
      .select("sku_id, shop_id, yz_item_id")
      .neq("shop_id", hqShopId)
      .in("shop_id", shopIds)
      .eq("role", "branch_stock")
      .eq("status", "linked")
      .in("sku_id", skuIds.slice(offset, offset + 500));
    if (error) throw new Error(error.message);
    links.push(
      ...((data ?? []) as Array<{ sku_id: string; shop_id: string; yz_item_id: number | null }>),
    );
  }
  const categoryBySkuId = new Map(
    (skuRows ?? []).map((sku) => [sku.id, String(sku.category ?? "")]),
  );
  const productLinks: ProductLink[] = links.flatMap((link) => {
    const itemId = positiveInteger(link.yz_item_id);
    const categoryCode = categoryBySkuId.get(link.sku_id) ?? "";
    return itemId && categoryCode
      ? [{ category_code: categoryCode, item_id: itemId, shop_id: link.shop_id }]
      : [];
  });
  return { categories, productLinks, shops };
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
  const source = await loadSourceData(hq.id, args.categoryCodes);
  const selectedProductLinks = selectProductLinksForCategories({
    categories: source.categories,
    productLinks: source.productLinks,
    maxItems: args.maxItems,
  });
  const targetShops = source.shops.filter((shop) =>
    selectedProductLinks.some((link) => link.shop_id === shop.id),
  );
  const runId = await createAuditRun({
    status: "running",
    dry_run: args.dryRun,
    hq_shop_id: hq.id,
    hq_kdt_id: hq.kdt_id,
    channels: args.channels,
    category_codes: args.categoryCodes,
    source_snapshot: {
      categories: source.categories,
      product_links: selectedProductLinks,
      shops: targetShops.map((shop) => ({
        id: shop.id,
        kdt_id: Number(shop.kdt_id),
        shop_name: shop.shop_name,
      })),
    },
  });

  const shopResults: Array<Record<string, unknown>> = [];
  try {
    for (const shop of targetShops) {
      const accessToken = await ensureAccessToken(shop);
      const shopProductLinks = selectedProductLinks.filter((link) => link.shop_id === shop.id);
      const channelResults: Array<Record<string, unknown>> = [];
      for (const channel of args.channels) {
        const remoteGroups = await listRemoteGroups({
          accessToken,
          kdtId: Number(shop.kdt_id),
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
                kdtId: Number(shop.kdt_id),
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
                hq_shop_id: shop.id,
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
          productLinks: shopProductLinks,
          groupIdsByCategoryCode,
        });
        const relationSnapshots: Array<Record<string, unknown>> = [];
        const updates: Array<Record<string, unknown>> = [];
        for (const assignment of assignments) {
          for (const itemIds of chunkYouzanItemIds(assignment.itemIds)) {
            const before = [];
            for (const itemId of itemIds) {
              const response = await callYouzanApiVerbose({
                accessToken,
                method: "youzan.item.itemgroup.get",
                version: "1.0.0",
                params: buildGroupRelationQueryParams(Number(shop.kdt_id), channel, itemId),
                timeoutMs: 20_000,
              });
              before.push({ item_id: itemId, payload: response.payload });
            }
            relationSnapshots.push({
              category_code: assignment.categoryCode,
              item_ids: itemIds,
              items: before,
            });
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
                kdtId: Number(shop.kdt_id),
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
                params: buildGroupRelationQueryParams(Number(shop.kdt_id), channel, itemId),
                timeoutMs: 20_000,
              });
              const verifiedGroupIds = collectRelationGroupIds(after.payload);
              if (!verifiedGroupIds.includes(assignment.groupId)) {
                throw new Error(
                  `分组覆盖后校验失败：${assignment.categoryCode} shop=${shop.shop_name} item=${itemId} group=${assignment.groupId}`,
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
          remote_groups_before: remoteGroups,
          planned_creates: creates,
          resolved_groups: resolvedGroups,
          relation_snapshots: relationSnapshots,
          updates,
        });
      }
      shopResults.push({
        shop: { id: shop.id, kdt_id: Number(shop.kdt_id), shop_name: shop.shop_name },
        channels: channelResults,
      });
    }

    const result = {
      run_id: runId,
      dry_run: args.dryRun,
      hq: { id: hq.id, kdt_id: Number(hq.kdt_id), shop_name: hq.shop_name },
      shop_count: targetShops.length,
      category_count: source.categories.length,
      product_count: new Set(selectedProductLinks.map((link) => link.item_id)).size,
      shops: shopResults,
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
      result: { shops: shopResults },
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}

export const categoryGroupServerInternals = {
  collectRemoteGroups,
  collectRelationGroupIds,
};
