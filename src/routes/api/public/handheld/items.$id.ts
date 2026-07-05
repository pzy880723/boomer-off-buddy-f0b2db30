import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildPrintPayload } from "@/server/handheld-print.server";
import { deriveListingStatus, statusLabel } from "@/lib/handheld/listing-status";

export const Route = createFileRoute("/api/public/handheld/items/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const { data: sku, error } = await supabaseAdmin
          .from("inv_skus")
          .select(
            "id, sku_code, barcode, epc, name, category, price_tier, is_custom_price, grade, image_url, image_paths, notes, weight_g, stock_qty, status, created_at, updated_at",
          )
          .eq("id", params.id)
          .maybeSingle();
        if (error) return errCode("internal_error", error.message);
        if (!sku) return errCode("not_found", "SKU not found");

        const { data: stocks } = await supabaseAdmin
          .from("inv_stocks")
          .select(
            "qty, location:inv_locations!location_id(id, name, kind)",
          )
          .eq("sku_id", params.id);

        const stockList = (stocks ?? [])
          .map((r: any) => {
            const loc = r.location;
            if (!loc) return null;
            return {
              location_id: loc.id,
              location_name: loc.name,
              location_kind: loc.kind as "warehouse" | "shop",
              qty: r.qty as number,
            };
          })
          .filter(Boolean);

        const imagePaths = ((sku as { image_paths?: string[] | null }).image_paths ?? []) as string[];
        const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
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
          sku_code: sku.sku_code,
          barcode: (sku as any).barcode ?? null,
          epc: sku.epc,
          name: sku.name,
          category: sku.category,
          price_tier: sku.price_tier,
          is_custom_price: sku.is_custom_price,
          condition_grade: (sku.grade as any) ?? null,
          grade: sku.grade,
          image_url: coverUrl,
          image_paths: imagePaths,
          images,
          notes: sku.notes,
          weight_g: sku.weight_g,
          stock_qty: sku.stock_qty,
          status: sku.status,
          created_at: sku.created_at,
          updated_at: sku.updated_at,
          stocks: stockList,
          print_payload: buildPrintPayload({
            sku_code: sku.sku_code,
            barcode: (sku as any).barcode ?? null,
            name: sku.name,
            price_tier: sku.price_tier,
            grade: sku.grade,
            condition_grade: (sku.grade as any) ?? null,
          }),
        });
      },
    },
  },
});
