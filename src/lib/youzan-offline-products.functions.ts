import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ensureAccessToken, getHqShop } from "./youzan.functions";
import { getPublicOrigin } from "./sku-media";
import {
  buildOfflineSkuIdentity,
  buildOfflineSkuReleaseInput,
  buildOfflineChannelListingRow,
  buildOfflineProductLookupTerms,
  buildOfflineStockQueueRow,
  findOfflineProductMatch,
  queryYouzanOfflineProducts,
  releaseYouzanOfflineProduct,
  resolveOfflineReleaseSourceImages,
  updateYouzanOfflineProduct,
} from "./youzan-offline-products.server";
import {
  ensureAutoYouzanDefaultCategory,
  ensureHqSpuLink,
  runStockSyncWorkerForSkus,
  uploadImageToYouzanMaterial,
} from "./youzan-sync.functions";

type OfflineReleaseResult = {
  shop_id: string;
  ok: boolean;
  item_id: number | null;
  sku_id: number | null;
  recovered: boolean;
  error: string | null;
};

async function findExistingOfflineProduct(args: {
  accessToken: string;
  warehouseCode: string | null;
  skuCode: string;
  name: string;
}) {
  if (!args.warehouseCode) return null;
  const target = {
    skuCode: args.skuCode,
    name: args.name,
  };

  for (const lookupTerm of buildOfflineProductLookupTerms(args)) {
    for (const displayStatus of [1, 2, 0] as const) {
      const queried = await queryYouzanOfflineProducts({
        accessToken: args.accessToken,
        input: {
          pageNo: 1,
          pageSize: 20,
          displayStatus,
          warehouseCode: args.warehouseCode,
          nameOrSkuNo: lookupTerm,
        },
      });
      const matched = findOfflineProductMatch(queried.rows, target);
      if (matched) return matched;
    }
  }
  return null;
}

async function upsertBranchLink(args: {
  skuId: string;
  shopId: string;
  hqSpuId: number;
  itemId: number;
  skuIdRemote: number | null;
  stock: number;
  recovered: boolean;
}) {
  const { error } = await supabase.from("sku_youzan_links").upsert(
    {
      sku_id: args.skuId,
      shop_id: args.shopId,
      yz_item_id: args.itemId,
      yz_sku_id: args.skuIdRemote,
      status: "linked",
      role: "branch_stock",
      sync_stock: true,
      last_error: null,
    } as never,
    { onConflict: "sku_id,shop_id" },
  );
  if (error) throw new Error(error.message);

  const listing = buildOfflineChannelListingRow(args);
  const existingQuery = supabase
    .from("sku_channel_listings")
    .select("id")
    .eq("sku_id", args.skuId)
    .eq("channel", "youzan_branch_offline")
    .eq("shop_id", args.shopId);
  const { data: existing, error: existingError } = await existingQuery.maybeSingle();
  if (existingError) throw new Error(existingError.message);
  const payload = {
    ...listing,
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const write = existing?.id
    ? supabase
        .from("sku_channel_listings")
        .update(payload as never)
        .eq("id", existing.id)
    : supabase.from("sku_channel_listings").insert(payload as never);
  const { error: listingError } = await write;
  if (listingError) throw new Error(listingError.message);
}

async function markBranchReleaseError(skuId: string, shopId: string, message: string) {
  const failure = message.slice(0, 400);
  const { error: linkError } = await supabase.from("sku_youzan_links").upsert(
    {
      sku_id: skuId,
      shop_id: shopId,
      yz_item_id: 0,
      yz_sku_id: null,
      status: "error",
      role: "branch_stock",
      sync_stock: false,
      last_error: failure,
    } as never,
    { onConflict: "sku_id,shop_id" },
  );
  if (linkError) throw new Error(linkError.message);

  const { data: existing, error: existingError } = await supabase
    .from("sku_channel_listings")
    .select("id")
    .eq("sku_id", skuId)
    .eq("channel", "youzan_branch_offline")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  const payload = {
    sku_id: skuId,
    channel: "youzan_branch_offline",
    shop_id: shopId,
    listing_status: "error",
    last_error: failure,
    updated_at: new Date().toISOString(),
  };
  const listingWrite = existing?.id
    ? supabase
        .from("sku_channel_listings")
        .update(payload as never)
        .eq("id", existing.id)
    : supabase.from("sku_channel_listings").insert(payload as never);
  const { error: listingError } = await listingWrite;
  if (listingError) throw new Error(listingError.message);
}

async function enqueueBranchStock(args: {
  skuId: string;
  shopId: string;
  locationId: string | null;
  targetStock: number;
}) {
  const row = buildOfflineStockQueueRow(args);
  const { data: existing } = await supabase
    .from("youzan_stock_sync_queue")
    .select("id")
    .eq("sku_id", args.skuId)
    .eq("shop_id", args.shopId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const query = existing?.id
    ? supabase
        .from("youzan_stock_sync_queue")
        .update(row as never)
        .eq("id", existing.id)
    : supabase.from("youzan_stock_sync_queue").insert(row as never);
  const { error } = await query;
  if (error) throw new Error(error.message);
}

export async function releaseSkuToOfflineShopsCore(args: {
  sku_id: string;
  shop_ids: string[];
  stock_override?: number;
}): Promise<{ ok: boolean; results: OfflineReleaseResult[] }> {
  const shopIds = Array.from(new Set(args.shop_ids));
  if (shopIds.length === 0) return { ok: true, results: [] };

  const [{ data: sku, error: skuError }, { data: shops, error: shopsError }] = await Promise.all([
      supabase
        .from("inv_skus")
        .select("id,name,sku_code,barcode,price_tier,image_url,image_paths,sku_scope")
        .eq("id", args.sku_id)
        .maybeSingle(),
      supabase
        .from("youzan_shops")
        .select("id,kdt_id,role,status,warehouse_code,access_token,refresh_token,token_expires_at")
        .in("id", shopIds),
    ]);
  if (skuError) throw new Error(skuError.message);
  if (shopsError) throw new Error(shopsError.message);
  if (!sku) throw new Error("SKU 不存在");

  const branches = (shops ?? []).filter(
    (shop) => shop.role === "branch" && shop.status === "active",
  );
  if (branches.length !== shopIds.length) {
    throw new Error("部分目标门店不存在、已停用或不是分店");
  }

  // inv_skus.image_paths 存的是私有桶路径（sku-listing/xxx.jpg），不是 URL。
  // 必须先转成 ERP 公开只读代理地址，有赞才抓得到；
  // 直接把桶路径丢给素材上传接口就是之前 [160400100] file 参数错误的根因。
  const publicOrigin = getPublicOrigin();
  const rawImages = resolveOfflineReleaseSourceImages({
    skuScope: sku.sku_scope,
    imageUrl: sku.image_url,
    imagePaths: sku.image_paths,
    publicOrigin,
  });
  if (rawImages.length === 0) throw new Error("商品缺少可对外访问的图片，无法发布到有赞门店");

  const remoteIdentity = buildOfflineSkuIdentity({
    id: sku.id,
    skuScope: sku.sku_scope,
    skuCode: String(sku.sku_code ?? ""),
    barcode: sku.barcode,
    name: sku.name,
    priceTier: sku.price_tier,
  });
  const posBarcode = String(sku.barcode ?? "").trim();
  if (!posBarcode) throw new Error("SKU 缺少 ERP 条码，无法同步有赞收银条码");

  const hq = await getHqShop();
  const accessToken = await ensureAccessToken(hq);
  const category = await ensureAutoYouzanDefaultCategory();
  const imageUrls = await Promise.all(
    rawImages.map((url) =>
      url.endsWith("/m-icon-512.png")
        ? Promise.resolve(url)
        : uploadImageToYouzanMaterial(accessToken, url, {
            shop_id: hq.id,
            kdt_id: hq.kdt_id,
            sku_id: args.sku_id,
          }),
    ),
  );

  const results: OfflineReleaseResult[] = [];
  for (const branch of branches) {
    // offline.spu.release publishes an existing HQ product to a branch.
    // Relation fields use Youzan's HQ codes; sku_no keeps the ERP barcode for POS scanning.
    const hqLink = await ensureHqSpuLink(args.sku_id, branch.id);
    const { data: location } = await supabase
      .from("inv_locations")
      .select("id")
      .eq("shop_id", branch.id)
      .maybeSingle();
    if (!location?.id) {
      throw new Error(`门店 ${branch.id} 未映射库位`);
    }
    let stock = Math.max(0, Math.trunc(args.stock_override ?? 0));
    if (args.stock_override === undefined) {
      const { data: localStock } = await supabase
        .from("inv_stocks")
        .select("qty")
        .eq("sku_id", args.sku_id)
        .eq("location_id", location.id)
        .maybeSingle();
      stock = Math.max(0, Math.trunc(Number(localStock?.qty ?? 0)));
    }
    const releaseInput = buildOfflineSkuReleaseInput({
      sku: {
        name: remoteIdentity.name,
        scanCode: posBarcode,
        hqSpuCode: hqLink.spu_code,
        hqSkuCode: hqLink.sku_code,
        priceYuan: Number(sku.price_tier ?? 0),
        imageUrls,
      },
      categoryId: category.id,
      branchKdtIds: [Number(branch.kdt_id)],
      stock,
    });

    // The live branch query is authoritative. Database links can become stale when Youzan
    // rewrites an offline item id or a product is recreated in the branch.
    const remoteExisting = await findExistingOfflineProduct({
      accessToken,
      warehouseCode: branch.warehouse_code,
      skuCode: remoteIdentity.code,
      name: remoteIdentity.name,
    });
    if (remoteExisting) {
      const remoteSkuId = remoteExisting.skus[0]?.skuId ?? null;
      await updateYouzanOfflineProduct({
        accessToken,
        itemId: remoteExisting.itemId,
        input: releaseInput,
      });
      await upsertBranchLink({
        skuId: args.sku_id,
        shopId: branch.id,
        hqSpuId: hqLink.yz_item_id,
        itemId: remoteExisting.itemId,
        skuIdRemote: remoteSkuId,
        stock,
        recovered: true,
      });
      await enqueueBranchStock({
        skuId: args.sku_id,
        shopId: branch.id,
        locationId: args.stock_override === undefined ? location.id : null,
        targetStock: stock,
      });
      results.push({
        shop_id: branch.id,
        ok: true,
        item_id: remoteExisting.itemId,
        sku_id: remoteSkuId,
        recovered: true,
        error: null,
      });
      continue;
    }

    try {
      const released = await releaseYouzanOfflineProduct({
        accessToken,
        input: releaseInput,
      });
      const remoteSkuId = released.skuIds[0] ?? null;
      await upsertBranchLink({
        skuId: args.sku_id,
        shopId: branch.id,
        hqSpuId: hqLink.yz_item_id,
        itemId: released.itemId,
        skuIdRemote: remoteSkuId,
        stock,
        recovered: false,
      });
      await enqueueBranchStock({
        skuId: args.sku_id,
        shopId: branch.id,
        locationId: args.stock_override === undefined ? location.id : null,
        targetStock: stock,
      });
      results.push({
        shop_id: branch.id,
        ok: true,
        item_id: released.itemId,
        sku_id: remoteSkuId,
        recovered: false,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let recovered: { itemId: number; skuId: number | null } | null = null;
      try {
        const matched = await findExistingOfflineProduct({
          accessToken,
          warehouseCode: branch.warehouse_code,
          skuCode: remoteIdentity.code,
          name: remoteIdentity.name,
        });
        if (matched) {
          recovered = { itemId: matched.itemId, skuId: matched.skus[0]?.skuId ?? null };
        }
      } catch {
        // 保留原始发布错误，避免查询失败覆盖真正原因。
      }
      if (recovered) {
        await upsertBranchLink({
          skuId: args.sku_id,
          shopId: branch.id,
          hqSpuId: hqLink.yz_item_id,
          itemId: recovered.itemId,
          skuIdRemote: recovered.skuId,
          stock,
          recovered: true,
        });
        await enqueueBranchStock({
          skuId: args.sku_id,
          shopId: branch.id,
            locationId: args.stock_override === undefined ? location.id : null,
          targetStock: stock,
        });
        results.push({
          shop_id: branch.id,
          ok: true,
          item_id: recovered.itemId,
          sku_id: recovered.skuId,
          recovered: true,
          error: null,
        });
      } else {
        await markBranchReleaseError(args.sku_id, branch.id, message);
        results.push({
          shop_id: branch.id,
          ok: false,
          item_id: null,
          sku_id: null,
          recovered: false,
          error: message,
        });
      }
    }
  }
  if (results.some((result) => result.ok)) {
    const worker = await runStockSyncWorkerForSkus([args.sku_id]);
    if (worker.failed > 0) {
      for (const result of results.filter((item) => item.ok)) {
        const { data: failedTask } = await supabase
          .from("youzan_stock_sync_queue")
          .select("last_error")
          .eq("sku_id", args.sku_id)
          .eq("shop_id", result.shop_id)
          .eq("status", "failed")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (failedTask?.last_error) {
          result.ok = false;
          result.error = String(failedTask.last_error);
        }
      }
    }
  }
  return { ok: results.every((result) => result.ok), results };
}

export const queryOfflineProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        page_no: z.number().int().positive().default(1),
        page_size: z.number().int().min(1).max(50).default(20),
        show_display: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        warehouse_code: z.string().trim().min(1).optional(),
        name_or_sku_no: z.string().trim().min(1).optional(),
        item_ids: z.array(z.number().int().positive()).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const hq = await getHqShop();
    const accessToken = await ensureAccessToken(hq);
    return queryYouzanOfflineProducts({
      accessToken,
      input: {
        pageNo: data.page_no,
        pageSize: data.page_size,
        displayStatus: data.show_display,
        warehouseCode: data.warehouse_code,
        nameOrSkuNo: data.name_or_sku_no,
        itemIds: data.item_ids,
      },
    });
  });

export const releaseOfflineProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        title: z.string().trim().min(1).max(200),
        category_id: z.number().int().positive(),
        unit: z.string().trim().min(1).max(20).default("件"),
        price_yuan: z.number().nonnegative(),
        image_urls: z.array(z.string().url()).min(1).max(5),
        spu_code: z.string().trim().min(1).max(100),
        sku_center_code: z.string().trim().min(1).max(100),
        sale_up_kdt_ids: z.array(z.number().int().positive()).min(1),
        sale_down_kdt_ids: z.array(z.number().int().positive()).default([]),
        sku_no: z.string().trim().min(1).max(100),
        stock: z.number().int().min(0).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const hq = await getHqShop();
    const accessToken = await ensureAccessToken(hq);
    return releaseYouzanOfflineProduct({
      accessToken,
      input: {
        title: data.title,
        categoryId: data.category_id,
        unit: data.unit,
        priceYuan: data.price_yuan,
        imageUrls: data.image_urls,
        spuCode: data.spu_code,
        skuCenterCode: data.sku_center_code,
        saleUpKdtIds: data.sale_up_kdt_ids,
        saleDownKdtIds: data.sale_down_kdt_ids,
        stock: {
          skuNo: data.sku_no,
          relatedSpuCode: data.spu_code,
          relatedSkuCode: data.sku_center_code,
          sellStockCount: data.stock,
        },
      },
    });
  });
