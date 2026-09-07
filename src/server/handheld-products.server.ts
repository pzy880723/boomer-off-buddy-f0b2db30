import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { err, resolveSessionUser, type DeviceContext } from "@/server/handheld-auth.server";
import {
  deriveListingStatus,
  statusLabel,
  type ListingStatus,
} from "@/lib/handheld/listing-status";
import {
  collectUniqueProductImagePaths,
  mergeSignedProductImages,
} from "@/lib/handheld-product-images";

type ProductType = "standard" | "custom" | "bundle";
type Location = {
  id: string;
  name: string;
  kind: "warehouse" | "shop";
  shop_id: string | null;
  is_active: boolean;
};
type Stock = { sku_id: string; location_id: string; qty: number };
export type ProductScope = {
  scope: "all" | `location:${string}`;
  locations: Location[];
  legacyWarehouseId: string | null;
};
type Inventory = ProductScope & { stocks: Stock[]; includeStandardCatalog: boolean };

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
  image_processing_status: string;
  notes: string | null;
  is_unlimited_stock: boolean;
  total_stock_qty: number;
  stocks: {
    location_id: string;
    location_name: string;
    location_kind: "warehouse" | "shop";
    stock_qty: number;
  }[];
  status: string;
  is_display: boolean;
  listing_status: ListingStatus;
  status_label: string;
  can_restock: boolean;
  created_at: string;
  updated_at: string;
};

const SKU_COLS =
  "id, sku_code, barcode, epc, name, category, price_tier, grade, image_url, image_paths, image_processing_status, notes, status, is_display, kind, is_custom_price, inventory_policy, stock_qty, created_at, updated_at";
export function productQuery() {
  return supabaseAdmin.from("inv_skus").select(SKU_COLS).order("id");
}
type SkuQuery = ReturnType<typeof productQuery>;
type Sku = NonNullable<Awaited<SkuQuery>["data"]>[number];
type PageQuery = {
  range(
    from: number,
    to: number,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

class ProductReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}
export function productReadError(error: unknown): Response {
  return error instanceof ProductReadError
    ? err(error.message, error.status, { code: error.code })
    : err("Unable to load scoped products", 500, { code: "product_query_failed" });
}

// Exhaust ordered pages even if the server caps them below the requested size.
// Partial data must never become a successful count.
async function readRows<T>(query: () => PageQuery): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await query().range(rows.length, rows.length + 499);
    if (error || !Array.isArray(data)) {
      throw new ProductReadError("Unable to load scoped products", 500, "product_query_failed");
    }
    if (data.length === 0) return rows;
    rows.push(...(data as T[]));
  }
}

export async function authorizeProductScope(
  request: Request,
  device: DeviceContext,
): Promise<ProductScope> {
  const session = await resolveSessionUser(request);
  if (!session) throw new ProductReadError("Employee session required", 401, "session_required");
  const params = new URL(request.url).searchParams;
  const requestedScope = (params.get("scope") ?? "current_location").toLowerCase();
  const scope = requestedScope === "authorized" ? "current_location" : requestedScope;
  const explicitLocation = params.get("location_id");
  if (
    !["current_location", "all"].includes(scope) ||
    params.getAll("scope").length > 1 ||
    params.getAll("location_id").length > 1 ||
    (scope === "all" && explicitLocation !== null)
  )
    throw new ProductReadError("Invalid product scope", 400, "invalid_scope");
  const locationId =
    explicitLocation !== null ? explicitLocation.toLowerCase() : device.location_id;
  if (
    scope !== "all" &&
    (!locationId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(locationId))
  ) {
    throw new ProductReadError("location_id required", 400, "location_required");
  }

  // loadUserRoles is intentionally not used: it discards database failures.
  const { data: hqRole, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", session.user_id)
    .in("role", ["super_admin", "hq_operator"])
    .limit(1)
    .maybeSingle();
  if (roleError)
    throw new ProductReadError("Unable to load product access", 500, "product_query_failed");
  const isHq = !!hqRole;
  if (scope === "all" && !isHq)
    throw new ProductReadError("HQ role required", 403, "scope_forbidden");
  if (!isHq) {
    const { data: permission, error: permissionError } = await supabaseAdmin
      .from("user_location_perms")
      .select("location_id")
      .eq("user_id", session.user_id)
      .eq("location_id", locationId!)
      .maybeSingle();
    if (permissionError)
      throw new ProductReadError("Unable to load product access", 500, "product_query_failed");
    if (!permission)
      throw new ProductReadError("Location not accessible", 403, "location_forbidden");
  }
  const allLocations = await readRows<Location>(() =>
    supabaseAdmin.from("inv_locations").select("id, name, kind, shop_id, is_active").order("id"),
  );
  const locations = allLocations.filter(
    (l) => l.is_active && (scope === "all" || l.id === locationId),
  );
  if (scope !== "all" && locations.length !== 1)
    throw new ProductReadError("Location not accessible", 403, "location_forbidden");
  // The legacy inbound writer only updates the cache, without a target location.
  // Assign it only if exactly one warehouse exists, including inactive locations.
  const warehouses = allLocations.filter((l) => l.kind === "warehouse");
  const legacyWarehouseId =
    warehouses.length === 1 && locations.some((l) => l.id === warehouses[0].id)
      ? warehouses[0].id
      : null;
  return {
    scope: scope === "all" ? "all" : `location:${locations[0].id}`,
    locations,
    legacyWarehouseId,
  };
}

export async function loadProductInventory(
  scope: ProductScope,
  skuId?: string,
): Promise<Inventory> {
  const locationIds = scope.locations.map((l) => l.id);
  const stocks =
    locationIds.length === 0
      ? []
      : await readRows<Stock>(() => {
          const query = supabaseAdmin
            .from("inv_stocks")
            .select("sku_id, location_id, qty")
            .in("location_id", locationIds)
            .order("sku_id")
            .order("location_id");
          return skuId === undefined ? query : query.eq("sku_id", skuId);
        });
  const shopIds = scope.locations.map((l) => l.shop_id).filter((id): id is string => !!id);
  const vintageShops =
    scope.scope === "all" || shopIds.length === 0
      ? []
      : await readRows<{ id: string }>(() =>
          supabaseAdmin
            .from("youzan_shops")
            .select("id")
            .in("id", shopIds)
            .eq("store_format", "vintage")
            .order("id"),
        );
  return { ...scope, stocks, includeStandardCatalog: vintageShops.length > 0 };
}

export async function loadScopedProductSkus(
  inventory: Inventory,
  filter: (query: SkuQuery) => SkuQuery,
): Promise<Sku[]> {
  if (inventory.scope === "all") return readRows<Sku>(() => filter(productQuery()));
  const ids = [...new Set(inventory.stocks.map((s) => s.sku_id))];
  const rows: Sku[] = [];
  // Keep IN lists below URL limits. Zero stock still proves location membership.
  for (let offset = 0; offset < ids.length; offset += 100) {
    rows.push(
      ...(await readRows<Sku>(() =>
        filter(productQuery().in("id", ids.slice(offset, offset + 100))),
      )),
    );
  }
  if (inventory.includeStandardCatalog) {
    rows.push(
      ...(await readRows<Sku>(() =>
        filter(
          productQuery().eq("kind", "single").eq("is_custom_price", false).eq("status", "active"),
        ),
      )),
    );
  }
  if (inventory.legacyWarehouseId) {
    rows.push(...(await readRows<Sku>(() => filter(productQuery().gt("stock_qty", 0)))));
  }
  return [...new Map(rows.map((s) => [s.id, s])).values()];
}

export function filterProductSearch(query: SkuQuery, keyword: string): SkuQuery {
  if (!keyword) return query;
  const like = JSON.stringify(`%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  return query.or(
    `sku_code.ilike.${like},name.ilike.${like},barcode.ilike.${like},category.ilike.${like}`,
  );
}

export function buildProductItems(skus: Sku[], inventory: Inventory): ProductItem[] {
  const locations = new Map(inventory.locations.map((l) => [l.id, l]));
  const bySku = new Map<string, Stock[]>();
  for (const stock of inventory.stocks) {
    const rows = bySku.get(stock.sku_id) ?? [];
    rows.push(stock);
    bySku.set(stock.sku_id, rows);
  }
  return skus.map((s) => {
    const productType = s.kind === "bundle" ? "bundle" : s.is_custom_price ? "custom" : "standard";
    const stockRows = [...(bySku.get(s.id) ?? [])];
    if (
      inventory.legacyWarehouseId &&
      Number(s.stock_qty) > 0 &&
      !stockRows.some((r) => r.location_id === inventory.legacyWarehouseId)
    ) {
      stockRows.push({
        sku_id: s.id,
        location_id: inventory.legacyWarehouseId,
        qty: Number(s.stock_qty),
      });
    }
    const stocks = stockRows.flatMap((r) => {
      const loc = locations.get(r.location_id);
      return loc
        ? [
            {
              location_id: loc.id,
              location_name: loc.name,
              location_kind: loc.kind,
              stock_qty: Number(r.qty) || 0,
            },
          ]
        : [];
    });
    const total = stocks.reduce((sum, r) => sum + r.stock_qty, 0);
    const unlimited = s.inventory_policy === "unlimited";
    const isDisplay = s.is_display !== false;
    const listingStatus =
      unlimited && isDisplay ? "selling" : deriveListingStatus(isDisplay, total);
    return {
      id: s.id,
      product_type: productType,
      editable: productType !== "standard",
      sku_code: s.sku_code,
      barcode: s.barcode,
      item_code: s.sku_code,
      name: s.name,
      category: s.category,
      price: Number(s.price_tier) || 0,
      condition_grade: (s.grade as ProductItem["condition_grade"]) ?? null,
      image_url:
        s.image_url && /^https?:\/\//i.test(s.image_url) && !s.image_url.includes("token=")
          ? s.image_url
          : null,
      image_paths: s.image_paths ?? [],
      images: [],
      image_processing_status: s.image_processing_status ?? "idle",
      notes: s.notes,
      is_unlimited_stock: unlimited,
      total_stock_qty: total,
      stocks,
      status: s.status,
      is_display: isDisplay,
      listing_status: listingStatus,
      status_label: statusLabel(listingStatus),
      can_restock: !unlimited && isDisplay && total === 0,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  });
}

export async function signProductItems(items: ProductItem[]): Promise<ProductItem[]> {
  const paths = collectUniqueProductImagePaths(items);
  const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
  const urls = await signSkuImagePaths(paths);
  const signed = new Map<string, string>();
  paths.forEach((path, index) => {
    if (urls[index]) signed.set(path, urls[index]!);
  });
  return mergeSignedProductImages(items, signed);
}
