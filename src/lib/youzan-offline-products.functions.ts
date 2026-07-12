import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ensureAccessToken, getHqShop } from "./youzan.functions";
import {
  queryYouzanOfflineProducts,
  releaseYouzanOfflineProduct,
} from "./youzan-offline-products.server";

export const queryOfflineProducts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        page_no: z.number().int().positive().default(1),
        page_size: z.number().int().min(1).max(100).default(20),
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
