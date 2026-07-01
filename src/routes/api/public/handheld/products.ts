// GET /api/public/handheld/products
// GET /api/public/handheld/products/lookup?code=...
// 全量商品总账（跨库位、含库存拆分、按类型加权排序）。
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

export type ProductItem = {
  id: string;
  product_type: ProductType;
  editable: boolean;
  sku_code: string | null;
  barcode: string | null;
  item_code: string | null;
  name: string;
  category: string | null;
  price: number;
  condition_grade: "N" | "S" | "A" | "B" | "C" | "J" | null;
  image_url: string | null;
  image_paths: string[];
  images: { storage_path: string; read_url: string }[];
  notes: string | null;
  total_stock_qty: number;
  stocks: StockRow[];
  status: string;
  created_at: string;
  updated_at: string;
};

type SkuRow = {
  id: string;
  sku_code: string | null;
  barcode: string | null;
  epc: string | null;
  name: string;
  category: string | null;
  price_tier: number;
  grade: string | null;
  image_url: string | null;
  image_paths: string[] | null;
  notes: string | null;
  status: string;
  kind: string;
  is_custom_price: boolean;
  stock_qty: number;
  created_at: string;
  updated_at: string;
};

type LocRow = { id: string; name: string; kind: "warehouse" | "shop" };

const SKU_COLS =
  "id, sku_code, barcode, epc, name, category, price_tier, grade, image_url, image_paths, notes, status, kind, is_custom_price, stock_qty, created_at, updated_at";

function classifyType(r: { kind: string; is_custom_price: boolean }): ProductType {
  if (r.kind === "bundle") return "bundle";
  if (r.is_custom_price) return "custom";
  return "standard";
}
function typeRank(t: ProductType): number {
  return t === "custom" ? 0 : t === "bundle" ? 1 : 2;
}

/** Resolve accessible locations for the caller (session-scoped RBAC). */
async function loadScopedLocations(
  request: Request,
): Promise<
  | { ok: true; locations: LocRow[]; isHq: boolean; allowedIds: string[] | null }
  | { ok: false; response: Response }
> {
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
  let locQ = supabaseAdmin
    .from("inv_locations")
    .select("id, name, kind, is_active")
    .eq("is_active", true);
  if (allowedIds) {
    if (allowedIds.length === 0) return { ok: true, locations: [], isHq, allowedIds };
    locQ = locQ.in("id", allowedIds);
  }
  const { data } = await locQ;
  return { ok: true, locations: (data ?? []) as LocRow[], isHq, allowedIds };
}

async function buildItems(skus: SkuRow[], locations: LocRow[]): Promise<ProductItem[]> {
  const warehouseIds = locations.filter((l) => l.kind === "warehouse").map((l) => l.id);
  const shopIds = locations.filter((l) => l.kind === "shop").map((l) => l.id);
  const primaryWarehouseId = warehouseIds[0] ?? null;
  const locById = new Map(locations.map((l) => [l.id, l]));

  let shopStocks: { sku_id: string; location_id: string; qty: number }[] = [];
  if (skus.length > 0 && shopIds.length > 0) {
    const { data: st } = await supabaseAdmin
      .from("inv_stocks")
      .select("sku_id, location_id, qty")
      .in("sku_id", skus.map((s) => s.id))
      .in("location_id", shopIds);
    shopStocks = (st ?? []) as typeof shopStocks;
  }

  // Batch-sign all visible image paths so list/detail/lookup stay consistent.
  const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
  const allPaths: string[] = [];
  const allIdx: { skuId: string; path: string }[] = [];
  skus.forEach((s, i) => {
    for (const p of s.image_paths ?? []) {
      if (!p) continue;
      allPaths.push(p);
      allIdx.push({ skuId: s.id, path: p });
    }
  });
  const signed = await signSkuImagePaths(allPaths);
  const imagesBySkuId = new Map<string, { storage_path: string; read_url: string }[]>();
  allIdx.forEach((entry, k) => {
    const url = signed[k];
    if (!url) return;
    const list = imagesBySkuId.get(entry.skuId) ?? [];
    list.push({ storage_path: entry.path, read_url: url });
    imagesBySkuId.set(entry.skuId, list);
  });

  return skus.map((s) => {
    const stocks: StockRow[] = [];
    if (primaryWarehouseId) {
      const w = locById.get(primaryWarehouseId)!;
      stocks.push({
        location_id: w.id,
        location_name: w.name,
        location_kind: "warehouse",
        stock_qty: Number(s.stock_qty) || 0,
      });
    }
    for (const r of shopStocks) {
      if (r.sku_id !== s.id) continue;
      const loc = locById.get(r.location_id);
      if (!loc) continue;
      stocks.push({
        location_id: loc.id,
        location_name: loc.name,
        location_kind: "shop",
        stock_qty: Number(r.qty) || 0,
      });
    }
    const total = stocks.reduce((sum, r) => sum + r.stock_qty, 0);
    const imagePaths = (s.image_paths ?? []) as string[];
    const images = imagesBySkuId.get(s.id) ?? [];
    const cover =
      images[0]?.read_url ??
      (s.image_url && /^https?:\/\//i.test(s.image_url) && !s.image_url.includes("token=")
        ? s.image_url
        : null);
    return {
      id: s.id,
      product_type: classifyType(s),
      editable: classifyType(s) !== "standard",
      sku_code: s.sku_code,
      barcode: s.barcode,
      item_code: s.sku_code,
      name: s.name,
      category: s.category,
      price: Number(s.price_tier) || 0,
      condition_grade: (s.grade as ProductItem["condition_grade"]) ?? null,
      image_url: cover,
      image_paths: imagePaths,
      images,
      notes: s.notes,
      total_stock_qty: total,
      stocks,
      status: s.status,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  });
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
        const scope = (url.searchParams.get("scope") || "authorized").toLowerCase();
        const locationFilter = url.searchParams.get("location_id") || null;
        const page = Math.max(1, Number(url.searchParams.get("page") || "1") | 0);
        const pageSize = Math.min(
          200,
          Math.max(1, Number(url.searchParams.get("page_size") || "50") | 0),
        );

        const scoped = await loadScopedLocations(request);
        if (!("locations" in scoped)) return scoped.response;
        let locations = scoped.locations;

        // scope: current_location → restrict to device.location_id (if allowed)
        if (scope === "current_location" && auth.device.location_id) {
          locations = locations.filter((l) => l.id === auth.device.location_id);
        }
        // explicit location_id filter (must be inside accessible scope)
        if (locationFilter) {
          if (!locations.some((l) => l.id === locationFilter)) {
            return err("Location not accessible", 403, { code: "location_forbidden" });
          }
          locations = locations.filter((l) => l.id === locationFilter);
        }

        // Non-HQ with zero locations → empty
        if (locations.length === 0 && scoped.allowedIds !== null) {
          return ok({ items: [], total: 0, page, page_size: pageSize });
        }

        // ---- query skus (cap 2000 for in-memory type-rank sort) ----
        let skuQ = supabaseAdmin
          .from("inv_skus")
          .select(SKU_COLS)
          .order("updated_at", { ascending: false })
          .limit(2000);

        if (type === "standard") skuQ = skuQ.eq("kind", "single").eq("is_custom_price", false);
        else if (type === "custom") skuQ = skuQ.eq("kind", "single").eq("is_custom_price", true);
        else if (type === "bundle") skuQ = skuQ.eq("kind", "bundle");

        if (q) {
          const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
          skuQ = skuQ.or(
            `sku_code.ilike.${like},name.ilike.${like},barcode.ilike.${like},category.ilike.${like}`,
          );
        }

        // Shop-only scope for non-HQ (no warehouse in scope): restrict to skus
        // that actually have inv_stocks rows in those shops.
        const shopIds = locations.filter((l) => l.kind === "shop").map((l) => l.id);
        const hasWarehouse = locations.some((l) => l.kind === "warehouse");
        if (!scoped.isHq && !hasWarehouse && shopIds.length > 0) {
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

        const { data: skuRows, error: skuErr } = await skuQ;
        if (skuErr) return err(skuErr.message, 500);
        const skus = (skuRows ?? []) as SkuRow[];

        const items = await buildItems(skus, locations);

        // custom → bundle → standard, then updated_at desc
        items.sort((a, b) => {
          const r = typeRank(a.product_type) - typeRank(b.product_type);
          if (r !== 0) return r;
          return (b.updated_at || "").localeCompare(a.updated_at || "");
        });

        const total = items.length;
        const from = (page - 1) * pageSize;
        const paged = items.slice(from, from + pageSize);

        return ok({ items: paged, total, page, page_size: pageSize });
      },
    },
  },
});
