// GET /api/public/handheld/products
// 全量商品总账（跨库位、含库存拆分）。APP 商品页用它替换 /sku/search。
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

type ProductType = "standard" | "custom" | "bundle";

type StockRow = {
  location_id: string;
  location_name: string;
  location_kind: "warehouse" | "shop";
  stock_qty: number;
};

type ProductItem = {
  id: string;
  product_type: ProductType;
  sku_code: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  price: number;
  condition_grade: "N" | "S" | "A" | "B" | "C" | "J" | null;
  image_url: string | null;
  notes: string | null;
  total_stock_qty: number;
  stocks: StockRow[];
  status: string;
  created_at: string;
  updated_at: string;
};

function classifyType(row: { kind: string; is_custom_price: boolean }): ProductType {
  if (row.kind === "bundle") return "bundle";
  if (row.is_custom_price) return "custom";
  return "standard";
}

export const Route = createFileRoute("/api/public/handheld/products")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        const q = (url.searchParams.get("q") || "").trim();
        const type = (url.searchParams.get("type") || "all").toLowerCase();
        const locationFilter = (url.searchParams.get("location_id") || "all").toLowerCase();
        const page = Math.max(1, Number(url.searchParams.get("page") || "1") | 0);
        const pageSize = Math.min(
          200,
          Math.max(1, Number(url.searchParams.get("page_size") || "50") | 0),
        );

        // ---- 1. determine accessible locations for this caller ----
        const session = await resolveSessionUser(request);
        let isHq = false;
        let allowedIds: string[] | null = null;
        if (session) {
          const roles = await loadUserRoles(session.user_id);
          isHq = roles.includes("super_admin") || roles.includes("hq_operator");
          if (!isHq) {
            const { data: perms } = await supabaseAdmin
              .from("user_location_perms" as never)
              .select("location_id")
              .eq("user_id", session.user_id);
            allowedIds = ((perms as { location_id: string }[] | null) ?? []).map(
              (p) => p.location_id,
            );
          }
        }

        let locQuery = supabaseAdmin
          .from("inv_locations")
          .select("id, name, kind, is_active")
          .eq("is_active", true);
        if (allowedIds) {
          if (allowedIds.length === 0) return ok({ items: [], total: 0, page, page_size: pageSize });
          locQuery = locQuery.in("id", allowedIds);
        }
        const { data: locData } = await locQuery;
        let locations = (locData ?? []) as {
          id: string;
          name: string;
          kind: "warehouse" | "shop";
        }[];

        // Optional location_id filter (must be within accessible scope)
        if (locationFilter !== "all") {
          if (!locations.some((l) => l.id === locationFilter)) {
            return err("Location not accessible", 403, { code: "location_forbidden" });
          }
          locations = locations.filter((l) => l.id === locationFilter);
        }

        const warehouseIds = locations.filter((l) => l.kind === "warehouse").map((l) => l.id);
        const shopIds = locations.filter((l) => l.kind === "shop").map((l) => l.id);
        // Deterministic "primary" warehouse used to attribute the sku-level
        // aggregate stock_qty (which is not per-location in this schema).
        const primaryWarehouseId = warehouseIds[0] ?? null;

        // ---- 2. query skus ----
        let skuQ = supabaseAdmin
          .from("inv_skus")
          .select(
            "id, sku_code, barcode, name, category, price_tier, grade, image_url, notes, status, kind, is_custom_price, stock_qty, created_at, updated_at",
            { count: "exact" },
          )
          .order("updated_at", { ascending: false });

        if (type === "standard") skuQ = skuQ.eq("kind", "single").eq("is_custom_price", false);
        else if (type === "custom") skuQ = skuQ.eq("kind", "single").eq("is_custom_price", true);
        else if (type === "bundle") skuQ = skuQ.eq("kind", "bundle");

        if (q) {
          const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
          skuQ = skuQ.or(
            `sku_code.ilike.${like},name.ilike.${like},barcode.ilike.${like},category.ilike.${like}`,
          );
        }

        // Non-HQ + shop-only scope: only skus that have inv_stocks rows in shopIds
        if (!isHq && session && shopIds.length > 0 && warehouseIds.length === 0) {
          const { data: sids } = await supabaseAdmin
            .from("inv_stocks")
            .select("sku_id")
            .in("location_id", shopIds)
            .gt("qty", 0);
          const ids = Array.from(
            new Set(((sids as { sku_id: string }[] | null) ?? []).map((r) => r.sku_id)),
          );
          if (ids.length === 0) return ok({ items: [], total: 0, page, page_size: pageSize });
          skuQ = skuQ.in("id", ids);
        }

        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        const { data: skuRows, count, error: skuErr } = await skuQ.range(from, to);
        if (skuErr) return err(skuErr.message, 500);

        const skus = (skuRows ?? []) as {
          id: string;
          sku_code: string | null;
          barcode: string | null;
          name: string;
          category: string | null;
          price_tier: number;
          grade: string | null;
          image_url: string | null;
          notes: string | null;
          status: string;
          kind: string;
          is_custom_price: boolean;
          stock_qty: number;
          created_at: string;
          updated_at: string;
        }[];

        // ---- 3. batch load per-location stocks (shops only; warehouse from sku.stock_qty) ----
        const skuIds = skus.map((s) => s.id);
        let shopStocks: { sku_id: string; location_id: string; qty: number }[] = [];
        if (skuIds.length > 0 && shopIds.length > 0) {
          const { data: st } = await supabaseAdmin
            .from("inv_stocks")
            .select("sku_id, location_id, qty")
            .in("sku_id", skuIds)
            .in("location_id", shopIds);
          shopStocks = (st ?? []) as typeof shopStocks;
        }

        const locById = new Map(locations.map((l) => [l.id, l]));

        const items: ProductItem[] = skus.map((s) => {
          const stocks: StockRow[] = [];
          // warehouse aggregate (attributed to primary warehouse when present)
          if (primaryWarehouseId && (s.stock_qty ?? 0) !== 0) {
            const w = locById.get(primaryWarehouseId)!;
            stocks.push({
              location_id: w.id,
              location_name: w.name,
              location_kind: "warehouse",
              stock_qty: s.stock_qty || 0,
            });
          }
          // shop rows
          for (const r of shopStocks) {
            if (r.sku_id !== s.id) continue;
            const loc = locById.get(r.location_id);
            if (!loc) continue;
            stocks.push({
              location_id: loc.id,
              location_name: loc.name,
              location_kind: "shop",
              stock_qty: r.qty || 0,
            });
          }
          const total = stocks.reduce((sum, r) => sum + (r.stock_qty || 0), 0);
          return {
            id: s.id,
            product_type: classifyType(s),
            sku_code: s.sku_code,
            barcode: s.barcode,
            name: s.name,
            category: s.category,
            price: Number(s.price_tier) || 0,
            condition_grade: (s.grade as ProductItem["condition_grade"]) ?? null,
            image_url: s.image_url,
            notes: s.notes,
            total_stock_qty: total,
            stocks,
            status: s.status,
            created_at: s.created_at,
            updated_at: s.updated_at,
          };
        });

        return ok({ items, total: count ?? items.length, page, page_size: pageSize });
      },
    },
  },
});
