import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type StorefrontLifecycle = "online" | "offline" | "sold" | "recycle";

export type StorefrontAdminRow = {
  id: string;
  sku_id: string;
  sku_code: string | null;
  barcode: string | null;
  title: string;
  cover_url: string | null;
  price: number;
  condition_grade: string | null;
  product_type: "custom" | "standard" | "bundle";
  status: "draft" | "published" | "reserved" | "sold" | "hidden" | "archived";
  lifecycle: StorefrontLifecycle;
  category_code: string | null;
  category_name: string;
  brand_name: string;
  brand_name_original: string | null;
  location_id: string;
  location_name: string;
  location_kind: string | null;
  location_stock: number;
  published_at: string | null;
  sold_at: string | null;
  updated_at: string;
};

type ListingRelationRow = {
  id: string;
  sku_id: string;
  location_id: string;
  title: string;
  cover_url: string | null;
  price: number;
  condition_grade: string | null;
  product_type: StorefrontAdminRow["product_type"];
  status: StorefrontAdminRow["status"];
  published_at: string | null;
  sold_at: string | null;
  updated_at: string;
  sku: {
    sku_code: string | null;
    barcode: string | null;
    category: string | null;
    kind: string;
    is_custom_price: boolean;
    brand: { name: string; name_original: string | null } | null;
  } | null;
  location: { name: string; kind: string | null } | null;
};

function lifecycleFor(status: StorefrontAdminRow["status"]): StorefrontLifecycle {
  if (status === "published" || status === "reserved") return "online";
  if (status === "sold") return "sold";
  if (status === "archived") return "recycle";
  return "offline";
}

export const listStorefrontListings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        search: z.string().trim().max(100).optional(),
        location_id: z.string().uuid().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let query = supabaseAdmin
      .from("commerce_listings" as never)
      .select(
        "id,sku_id,location_id,title,cover_url,price,condition_grade,product_type,status,published_at,sold_at,updated_at,sku:inv_skus!sku_id(sku_code,barcode,category,kind,is_custom_price,brand:inv_brands!brand_id(name,name_original)),location:inv_locations!location_id(name,kind)",
      )
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (data.location_id) query = query.eq("location_id", data.location_id);
    const { data: rawRows, error } = await query;
    if (error) throw new Error(error.message);

    const relationRows = (rawRows ?? []) as unknown as ListingRelationRow[];
    const skuIds = [...new Set(relationRows.map((row) => row.sku_id))];
    const locationIds = [...new Set(relationRows.map((row) => row.location_id))];
    const categoryCodes = [
      ...new Set(relationRows.map((row) => row.sku?.category).filter(Boolean)),
    ] as string[];

    const [stockResult, categoryResult] = await Promise.all([
      skuIds.length && locationIds.length
        ? supabaseAdmin
            .from("inv_stocks")
            .select("sku_id,location_id,qty")
            .in("sku_id", skuIds)
            .in("location_id", locationIds)
        : Promise.resolve({ data: [], error: null }),
      categoryCodes.length
        ? supabaseAdmin
            .from("inv_categories" as never)
            .select("code,name")
            .in("code", categoryCodes)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (stockResult.error) throw new Error(stockResult.error.message);
    if (categoryResult.error) throw new Error(categoryResult.error.message);

    const stockByKey = new Map(
      ((stockResult.data ?? []) as Array<{ sku_id: string; location_id: string; qty: number }>).map(
        (row) => [`${row.sku_id}:${row.location_id}`, Number(row.qty) || 0],
      ),
    );
    const categoryByCode = new Map(
      ((categoryResult.data ?? []) as unknown as Array<{ code: string; name: string }>).map(
        (row) => [row.code, row.name],
      ),
    );
    const needle = data.search?.toLocaleLowerCase() ?? "";
    const rows: StorefrontAdminRow[] = relationRows
      .map((row) => ({
        id: row.id,
        sku_id: row.sku_id,
        sku_code: row.sku?.sku_code ?? null,
        barcode: row.sku?.barcode ?? null,
        title: row.title,
        cover_url: row.cover_url,
        price: Number(row.price) || 0,
        condition_grade: row.condition_grade,
        product_type: row.product_type,
        status: row.status,
        lifecycle: lifecycleFor(row.status),
        category_code: row.sku?.category ?? null,
        category_name: row.sku?.category
          ? (categoryByCode.get(row.sku.category) ?? row.sku.category)
          : "未分类",
        brand_name: row.sku?.brand?.name ?? "未设置",
        brand_name_original: row.sku?.brand?.name_original ?? null,
        location_id: row.location_id,
        location_name: row.location?.name ?? "未知门店",
        location_kind: row.location?.kind ?? null,
        location_stock: stockByKey.get(`${row.sku_id}:${row.location_id}`) ?? 0,
        published_at: row.published_at,
        sold_at: row.sold_at,
        updated_at: row.updated_at,
      }))
      .filter((row) => {
        if (!needle) return true;
        return [
          row.title,
          row.sku_code,
          row.barcode,
          row.category_name,
          row.brand_name,
          row.brand_name_original,
          row.location_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle);
      });

    return {
      rows,
      counts: {
        online: rows.filter((row) => row.lifecycle === "online").length,
        offline: rows.filter((row) => row.lifecycle === "offline").length,
        sold: rows.filter((row) => row.lifecycle === "sold").length,
        recycle: rows.filter((row) => row.lifecycle === "recycle").length,
      },
    };
  });

const ListingAction = z.object({
  id: z.string().uuid(),
  action: z.enum(["publish", "hide", "archive", "restore"]),
});

export const updateStorefrontListingLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ListingAction.parse(input))
  .handler(async ({ data }) => {
    const { data: listing, error } = await supabaseAdmin
      .from("commerce_listings" as never)
      .select("id,sku_id,location_id,status,published_at")
      .eq("id", data.id)
      .single();
    if (error || !listing) throw new Error(error?.message ?? "网店商品不存在");
    const row = listing as unknown as {
      id: string;
      sku_id: string;
      location_id: string;
      status: StorefrontAdminRow["status"];
      published_at: string | null;
    };
    if (row.status === "reserved") throw new Error("商品已被订单锁定，不能手动变更状态");

    let nextStatus: StorefrontAdminRow["status"];
    if (data.action === "publish") {
      if (row.status === "sold" || row.status === "archived") {
        throw new Error("售罄或回收站商品需先完成退货复检，再重新上架");
      }
      const { data: stock, error: stockError } = await supabaseAdmin
        .from("inv_stocks")
        .select("qty")
        .eq("sku_id", row.sku_id)
        .eq("location_id", row.location_id)
        .maybeSingle();
      if (stockError) throw new Error(stockError.message);
      if (Number(stock?.qty ?? 0) < 1) throw new Error("所属门店没有可售库存，不能上架");
      nextStatus = "published";
    } else if (data.action === "hide") {
      nextStatus = "hidden";
    } else if (data.action === "archive") {
      nextStatus = "archived";
    } else {
      if (row.status !== "archived") throw new Error("只有回收站商品可以恢复");
      nextStatus = "hidden";
    }

    const payload = {
      status: nextStatus,
      published_at:
        nextStatus === "published"
          ? (row.published_at ?? new Date().toISOString())
          : row.published_at,
      updated_at: new Date().toISOString(),
    };
    const { error: updateError } = await supabaseAdmin
      .from("commerce_listings" as never)
      .update(payload as never)
      .eq("id", row.id);
    if (updateError) throw new Error(updateError.message);
    return { id: row.id, status: nextStatus };
  });
