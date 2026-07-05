// GET /api/public/handheld/global-stock
// 全局库存视图（总仓账号专用）：跨所有 location × 所有商品类型，返回矩阵数据。
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  loadUserRoles,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deriveListingStatus, statusLabel } from "@/lib/handheld/listing-status";

type ProductType = "standard" | "custom" | "bundle";
type LocRow = { id: string; name: string; kind: "warehouse" | "shop" };

export const Route = createFileRoute("/api/public/handheld/global-stock")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        // ---- RBAC: HQ only ----
        const session = await resolveSessionUser(request);
        if (!session) return err("Unauthorized", 401);
        const roles = await loadUserRoles(session.user_id);
        const isHq = roles.includes("super_admin") || roles.includes("hq_operator");
        if (!isHq) return err("HQ role required", 403, { code: "hq_required" });

        const url = new URL(request.url);
        const typeRaw = (url.searchParams.get("type") || "").toLowerCase();
        if (typeRaw !== "standard" && typeRaw !== "custom" && typeRaw !== "bundle") {
          return err("type is required (standard|custom|bundle)", 400);
        }
        const type = typeRaw as ProductType;
        const q = (url.searchParams.get("q") || "").trim();
        const categoryFilter = (url.searchParams.get("category") || "").trim() || null;
        const stockState = (url.searchParams.get("stock_state") || "all").toLowerCase();
        const statusFilter = (url.searchParams.get("status") || "all").toLowerCase() as
          | "selling"
          | "sold_out"
          | "in_warehouse"
          | "all";
        const lowThreshold = Math.max(1, Number(url.searchParams.get("low_threshold") || "5") | 0);
        const page = Math.max(1, Number(url.searchParams.get("page") || "1") | 0);
        const pageSize = Math.min(
          200,
          Math.max(1, Number(url.searchParams.get("page_size") || "50") | 0),
        );

        // ---- all active locations, warehouse first ----
        const { data: locData, error: locErr } = await supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("is_active", true);
        if (locErr) return err(locErr.message, 500);
        const locations: LocRow[] = ((locData ?? []) as LocRow[]).sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "warehouse" ? -1 : 1;
          return a.name.localeCompare(b.name, "zh-Hans-CN");
        });
        const primaryWarehouseId =
          locations.find((l) => l.kind === "warehouse")?.id ?? null;
        const shopIds = locations.filter((l) => l.kind === "shop").map((l) => l.id);

        // ---- SKUs by type ----
        let skuQ = supabaseAdmin
          .from("inv_skus")
          .select(
            "id, sku_code, barcode, name, category, price_tier, image_url, image_paths, kind, is_custom_price, is_display, stock_qty, created_at, updated_at",
          )
          .order("updated_at", { ascending: false })
          .limit(3000);
        if (type === "standard") skuQ = skuQ.eq("kind", "single").eq("is_custom_price", false);
        else if (type === "custom") skuQ = skuQ.eq("kind", "single").eq("is_custom_price", true);
        else skuQ = skuQ.eq("kind", "bundle");
        if (categoryFilter) skuQ = skuQ.eq("category", categoryFilter);
        if (statusFilter === "in_warehouse") skuQ = skuQ.eq("is_display", false);
        else if (statusFilter === "selling" || statusFilter === "sold_out")
          skuQ = skuQ.eq("is_display", true);
        if (q) {
          const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
          skuQ = skuQ.or(
            `sku_code.ilike.${like},name.ilike.${like},barcode.ilike.${like},category.ilike.${like}`,
          );
        }
        const { data: skuRows, error: skuErr } = await skuQ;
        if (skuErr) return err(skuErr.message, 500);
        const skus = (skuRows ?? []) as Array<{
          id: string;
          sku_code: string | null;
          barcode: string | null;
          name: string;
          category: string | null;
          price_tier: number;
          image_url: string | null;
          image_paths: string[] | null;
          kind: string;
          is_custom_price: boolean;
          stock_qty: number;
        }>;

        // ---- shop stocks ----
        let shopStocks: { sku_id: string; location_id: string; qty: number }[] = [];
        if (skus.length > 0 && shopIds.length > 0) {
          const { data: st } = await supabaseAdmin
            .from("inv_stocks")
            .select("sku_id, location_id, qty")
            .in("sku_id", skus.map((s) => s.id))
            .in("location_id", shopIds);
          shopStocks = (st ?? []) as typeof shopStocks;
        }

        // ---- sign images (batch) ----
        const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
        const paths: string[] = [];
        const idxMap: string[] = [];
        skus.forEach((s) => {
          const first = (s.image_paths ?? [])[0];
          if (first) {
            paths.push(first);
            idxMap.push(s.id);
          }
        });
        const signed = await signSkuImagePaths(paths);
        const coverBySku = new Map<string, string>();
        idxMap.forEach((id, i) => {
          if (signed[i]) coverBySku.set(id, signed[i]);
        });

        // ---- build items ----
        type Item = {
          sku_id: string;
          name: string;
          sku_code: string | null;
          barcode: string | null;
          category: string | null;
          product_type: ProductType;
          image_url: string | null;
          price: number;
          total_qty: number;
          stocks: Record<string, number>;
        };
        const items: Item[] = skus.map((s) => {
          const stocks: Record<string, number> = {};
          if (primaryWarehouseId) stocks[primaryWarehouseId] = Number(s.stock_qty) || 0;
          for (const r of shopStocks) {
            if (r.sku_id !== s.id) continue;
            stocks[r.location_id] = Number(r.qty) || 0;
          }
          const total = Object.values(stocks).reduce((a, b) => a + b, 0);
          return {
            sku_id: s.id,
            name: s.name,
            sku_code: s.sku_code,
            barcode: s.barcode,
            category: s.category,
            product_type: type,
            image_url:
              coverBySku.get(s.id) ??
              (s.image_url && /^https?:\/\//i.test(s.image_url) && !s.image_url.includes("token=")
                ? s.image_url
                : null),
            price: Number(s.price_tier) || 0,
            total_qty: total,
            stocks,
          };
        });

        // ---- stock_state filter ----
        const filtered = items.filter((it) => {
          if (stockState === "out") return it.total_qty === 0;
          if (stockState === "low") return it.total_qty > 0 && it.total_qty < lowThreshold;
          return true;
        });

        // ---- summary (over all matched items, pre-pagination) ----
        const summary = {
          sku_count: filtered.length,
          total_qty: filtered.reduce((a, b) => a + b.total_qty, 0),
          out_of_stock: filtered.filter((it) => it.total_qty === 0).length,
          low_stock: filtered.filter(
            (it) => it.total_qty > 0 && it.total_qty < lowThreshold,
          ).length,
        };

        const total = filtered.length;
        const from = (page - 1) * pageSize;
        const paged = filtered.slice(from, from + pageSize);

        return ok({
          locations,
          items: paged,
          summary,
          page,
          page_size: pageSize,
          total,
        });
      },
    },
  },
});
