// GET /api/public/handheld/products/lookup?code=<barcode|sku_code|epc|qr_payload>
// 兼容 GET /products/lookup?q=<keyword>：无 code 时按关键词返回第一条。
// 扫码/条码/EPC 查商品，返回单项与 /products.items[] 同构。
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

const SKU_COLS =
  "id, sku_code, barcode, epc, name, category, price_tier, grade, image_url, image_paths, notes, status, kind, is_custom_price, stock_qty, created_at, updated_at";

type LocRow = { id: string; name: string; kind: "warehouse" | "shop" };

function classifyType(r: { kind: string; is_custom_price: boolean }) {
  if (r.kind === "bundle") return "bundle" as const;
  if (r.is_custom_price) return "custom" as const;
  return "standard" as const;
}

/** Extract a raw code from either a plain scan or a QR JSON payload. */
function normalizeCode(input: string): string {
  const s = input.trim();
  if (!s) return "";
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      return String(obj.epc || obj.barcode || obj.sku_code || obj.code || "").trim();
    } catch {
      /* fallthrough */
    }
  }
  return s;
}

export const Route = createFileRoute("/api/public/handheld/products/lookup")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        const raw = url.searchParams.get("code") || "";
        const keyword = (url.searchParams.get("q") || "").trim();
        const code = normalizeCode(raw);
        if (!code && !keyword) return err("Missing code", 400, { code: "missing_code" });

        // Try in order: barcode → sku_code → epc
        let sku: any = null;
        if (code) {
          for (const col of ["barcode", "sku_code", "epc"]) {
            const { data } = await supabaseAdmin
              .from("inv_skus")
              .select(SKU_COLS)
              .eq(col as never, code)
              .maybeSingle();
            if (data) {
              sku = data;
              break;
            }
          }
        } else if (keyword) {
          const like = `%${keyword.replace(/[%_]/g, (m) => `\\${m}`)}%`;
          const { data } = await supabaseAdmin
            .from("inv_skus")
            .select(SKU_COLS)
            .or(
              `sku_code.ilike.${like},name.ilike.${like},barcode.ilike.${like},category.ilike.${like}`,
            )
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          sku = data;
        }
        if (!sku) return err("Product not found", 404, { code: "not_found" });

        // RBAC-scoped locations
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
          if (allowedIds.length === 0) {
            return ok(buildEmptyItem(sku));
          }
          locQ = locQ.in("id", allowedIds);
        }
        const { data: locData } = await locQ;
        const locations = (locData ?? []) as LocRow[];

        const warehouseIds = locations.filter((l) => l.kind === "warehouse").map((l) => l.id);
        const shopIds = locations.filter((l) => l.kind === "shop").map((l) => l.id);
        const primaryWarehouseId = warehouseIds[0] ?? null;
        const locById = new Map(locations.map((l) => [l.id, l]));

        let shopStocks: { location_id: string; qty: number }[] = [];
        if (shopIds.length > 0) {
          const { data: st } = await supabaseAdmin
            .from("inv_stocks")
            .select("location_id, qty")
            .eq("sku_id", sku.id)
            .in("location_id", shopIds);
          shopStocks = (st ?? []) as typeof shopStocks;
        }

        const stocks: {
          location_id: string;
          location_name: string;
          location_kind: "warehouse" | "shop";
          stock_qty: number;
        }[] = [];
        if (primaryWarehouseId) {
          const w = locById.get(primaryWarehouseId)!;
          stocks.push({
            location_id: w.id,
            location_name: w.name,
            location_kind: "warehouse",
            stock_qty: Number(sku.stock_qty) || 0,
          });
        }
        for (const r of shopStocks) {
          const loc = locById.get(r.location_id);
          if (!loc) continue;
          stocks.push({
            location_id: loc.id,
            location_name: loc.name,
            location_kind: "shop",
            stock_qty: Number(r.qty) || 0,
          });
        }

        const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
        const imagePaths = (sku.image_paths ?? []) as string[];
        const signedList = await signSkuImagePaths(imagePaths);
        const images = imagePaths
          .map((p, i) => (signedList[i] ? { storage_path: p, read_url: signedList[i]! } : null))
          .filter((x): x is { storage_path: string; read_url: string } => x !== null);
        const coverUrl =
          images[0]?.read_url ??
          (sku.image_url && /^https?:\/\//i.test(sku.image_url) && !sku.image_url.includes("token=")
            ? sku.image_url
            : null);

        return ok({
          id: sku.id,
          product_type: classifyType(sku),
          sku_code: sku.sku_code,
          barcode: sku.barcode,
          item_code: sku.sku_code,
          name: sku.name,
          category: sku.category,
          price: Number(sku.price_tier) || 0,
          condition_grade: sku.grade ?? null,
          image_url: coverUrl,
          image_paths: imagePaths,
          images,
          notes: sku.notes,
          total_stock_qty: stocks.reduce((s, r) => s + r.stock_qty, 0),
          stocks,
          status: sku.status,
          created_at: sku.created_at,
          updated_at: sku.updated_at,
        });
      },
    },
  },
});

function buildEmptyItem(sku: any) {
  const imagePaths = (sku.image_paths ?? []) as string[];
  const imageUrl =
    sku.image_url && /^https?:\/\//i.test(sku.image_url) && !sku.image_url.includes("token=")
      ? sku.image_url
      : null;
  return {
    id: sku.id,
    product_type: classifyType(sku),
    sku_code: sku.sku_code,
    barcode: sku.barcode,
    item_code: sku.sku_code,
    name: sku.name,
    category: sku.category,
    price: Number(sku.price_tier) || 0,
    condition_grade: sku.grade ?? null,
    image_url: imageUrl,
    image_paths: imagePaths,
    images: [],
    notes: sku.notes,
    total_stock_qty: 0,
    stocks: [],
    status: sku.status,
    created_at: sku.created_at,
    updated_at: sku.updated_at,
  };
}
